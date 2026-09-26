/*
 * Long-running soak (roadmap P1-E): the full app with 10 local repositories
 * and one remote-only source, under steady change for hours.
 *
 *   node scripts/soak.ts <hours> <log.jsonl>
 *
 * Every ~20 s: a commit or branch change somewhere. Every ~2 min: a push to
 * the remote. Every hour: the remote goes offline for 3 minutes. An SSE client
 * stays connected and reconnects every 10 minutes. Every minute a sample of
 * memory, heap, event clients, reads, and errors is appended to the log. At
 * the end, the first and last hours are compared to check for growth.
 */
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig } from "../src/config/config.ts";
import { buildFixture, fixtureGit } from "../src/demo/builder.ts";
import { forkMerge, gardenTour } from "../src/demo/fixtures.ts";
import { startApp } from "../src/server/app.ts";

const hours = Number(process.argv[2] ?? 8);
const log = process.argv[3] ?? "soak.jsonl";
const endAt = Date.now() + hours * 3_600_000;
const random = (n: number) => Math.floor(Math.random() * n);

const root = await mkdtemp(join(tmpdir(), "git-garden-soak-"));
const locals: string[] = [];
for (let i = 0; i < 10; i++)
  locals.push(
    (await buildFixture(gardenTour, join(root, `r${String(i)}`))).dir,
  );
const seed = await buildFixture(forkMerge, join(root, "seed"));
const server = join(root, "server.git");
const pusher = join(root, "pusher");
await fixtureGit(root, ["clone", "--quiet", "--bare", seed.dir, server]);
await fixtureGit(root, ["clone", "--quiet", server, pusher]);

const parsed = parseConfig(
  JSON.stringify({
    version: 1,
    history: { timeZone: "America/New_York" },
    monitor: { remotePollSeconds: 30 },
    repositories: [
      ...locals.map((d, i) => ({ id: `r${String(i)}`, path: d })),
      { id: "remote", url: pathToFileURL(server).href },
    ],
  }),
  root,
);
if (!parsed.ok) throw new Error("config");
const app = await startApp(parsed.config, {
  port: 0,
  uiDir: null,
  cacheRoot: join(root, "cache"),
});
await writeFile(log, "");

let events = 0;
let sseErrors = 0;
let client: ClientRequest | null = null;
function connect(): void {
  client?.destroy();
  client = request(`${app.url}api/events`, (res) => {
    res.on("data", () => {
      events++;
    });
  });
  client.on("error", () => {
    sseErrors++;
  });
  client.end();
}
connect();

let changes = 0;
let changeErrors = 0;
const timers: ReturnType<typeof setInterval>[] = [];
timers.push(
  setInterval(() => {
    const dir = locals[random(locals.length)] as string;
    const action = random(3);
    const args =
      action === 0
        ? [
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            `soak ${String(changes)}`,
          ]
        : action === 1
          ? ["branch", "--force", `soak-${String(random(5))}`, "HEAD"]
          : ["branch", "-D", `soak-${String(random(5))}`];
    fixtureGit(dir, args).then(
      () => changes++,
      () => (action === 2 ? changes++ : changeErrors++), // deleting a missing branch is fine
    );
  }, 20_000),
);
timers.push(
  setInterval(() => {
    fixtureGit(pusher, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "remote soak",
    ])
      .then(() =>
        fixtureGit(pusher, ["push", "--quiet", "origin", "HEAD:main"]),
      )
      .then(
        () => changes++,
        () => changeErrors++,
      );
  }, 120_000),
);
timers.push(
  setInterval(() => {
    void (async () => {
      await rename(server, `${server}.offline`).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 180_000));
      await rename(`${server}.offline`, server).catch(() => undefined);
    })();
  }, 3_600_000),
);
timers.push(setInterval(connect, 600_000));

const started = Date.now();
timers.push(
  setInterval(() => {
    const d = app.service.diagnostics();
    const m = process.memoryUsage();
    const sample = {
      minute: Math.round((Date.now() - started) / 60_000),
      rss: m.rss,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      activeHandles: (
        process as unknown as { _getActiveHandles(): unknown[] }
      )._getActiveHandles().length,
      events,
      sseErrors,
      changes,
      changeErrors,
      reads: d.reduce((a, r) => a + r.timings.reads, 0),
      fetchFailures: d.reduce((a, r) => a + r.timings.fetchFailures, 0),
      states: d.map((r) => r.status.state).join(","),
      remote: d.find((r) => r.id === "remote")?.remote?.state,
    };
    void appendFile(log, `${JSON.stringify(sample)}\n`);
  }, 60_000),
);

await new Promise((r) => setTimeout(r, Math.max(0, endAt - Date.now())));
for (const t of timers) clearInterval(t);
(client as ClientRequest | null)?.destroy();
await app.close();
await rm(root, { recursive: true, force: true, maxRetries: 5 });
console.log(`soak finished after ${String(hours)} h; samples in ${log}`);
