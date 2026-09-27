/*
 * Live-service measurements for the roadmap section 12 targets (P1-E):
 * warm startup, change detection latency (watchers, and reconciliation
 * alone), incremental graph build time, idle CPU, and memory.
 *
 *   npm run bench:live             # 10 repositories, 20 changes each mode, 60 s idle
 *   npm run bench:live -- --quick  # 3 repositories, 5 changes, 10 s idle
 *
 * The service runs in this process with its production intervals
 * (5 s reconciliation) unless a mode says otherwise.
 */
import { cpus, tmpdir, totalmem } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../src/config/config.ts";
import { buildFixture, fixtureGit } from "../src/demo/builder.ts";
import { gardenTour } from "../src/demo/fixtures.ts";
import { RepositoryService } from "../src/monitor/repository-service.ts";

const quick = process.argv.includes("--quick");
const REPOS = quick ? 3 : 10;
const CHANGES = quick ? 5 : 20;
const IDLE_MS = quick ? 10_000 : 60_000;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ] as number;
};
const ms = (n: number) => `${n.toFixed(0)} ms`;

/** Percentage of all CPU time that was busy over the interval, machine-wide. */
async function machineBusy(durationMs: number): Promise<number> {
  const sample = () =>
    cpus().reduce(
      (acc, c) => {
        const t = c.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.irq + t.idle;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const a = sample();
  await new Promise((r) => setTimeout(r, durationMs));
  const b = sample();
  return (1 - (b.idle - a.idle) / (b.total - a.total)) * 100;
}

const root = await mkdtemp(join(tmpdir(), "git-flower-garden-bench-live-"));
try {
  const dirs: string[] = [];
  for (let i = 0; i < REPOS; i++)
    dirs.push(
      (await buildFixture(gardenTour, join(root, `repo-${String(i)}`))).dir,
    );
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: dirs.map((d, i) => ({ id: `r${String(i)}`, path: d })),
    }),
    root,
  );
  if (!parsed.ok) throw new Error("config");
  const config = parsed.config;

  async function start(options: { watch: boolean; reconcileMs?: number }) {
    const svc = new RepositoryService(config, {
      background: true,
      watch: options.watch,
      cacheRoot: join(root, "cache"),
      ...(options.reconcileMs
        ? { intervals: { reconcileMs: options.reconcileMs } }
        : {}),
    });
    const t0 = performance.now();
    let firstReadyMs = Number.NaN;
    const unsubscribe = svc.subscribe((e) => {
      if (
        Number.isNaN(firstReadyMs) &&
        e.type === "repository" &&
        svc.view(e.id)?.status.state === "ready"
      ) {
        firstReadyMs = performance.now() - t0;
      }
    });
    await svc.start();
    await Promise.all(svc.ids().map((id) => svc.graph(id)));
    unsubscribe();
    return { svc, startupMs: performance.now() - t0, firstReadyMs };
  }

  async function detection(
    svc: RepositoryService,
    label: string,
  ): Promise<{ latencies: number[]; graphs: number[] }> {
    const latencies: number[] = [];
    const graphs: number[] = [];
    for (let n = 0; n < CHANGES; n++) {
      const id = `r${String(n % REPOS)}`;
      const dir = dirs[n % REPOS] as string;
      const before = svc.view(id)?.revision ?? 0;
      await fixtureGit(dir, ["branch", `${label}-${String(n)}`]);
      const changed = performance.now();
      while ((svc.view(id)?.revision ?? 0) <= before) {
        if (performance.now() - changed > 30_000)
          throw new Error("change not detected");
        await new Promise((r) => setTimeout(r, 10));
      }
      latencies.push(performance.now() - changed);
      const g0 = performance.now();
      await svc.graph(id);
      graphs.push(performance.now() - g0);
      // Spread changes out so they do not all land in one reconcile interval.
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    }
    return { latencies, graphs };
  }

  console.log(
    `Node ${process.version}, ${cpus()[0]?.model ?? "?"} x${String(cpus().length)}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB, ${process.platform}; ${String(REPOS)} repositories`,
  );
  console.log("| Measurement | Result | Roadmap target |");
  console.log("| --- | --- | --- |");

  // Watchers on, production reconciliation (5 s).
  const watched = await start({ watch: true });
  console.log(
    `| Startup: first repository ready (the page is served before any read) | ${ms(watched.firstReadyMs)} | first cached view <= 2 s |`,
  );
  console.log(
    `| Startup: every repository read, with its first graph | ${ms(watched.startupMs)} | (no separate target) |`,
  );
  const w = await detection(watched.svc, "w");
  console.log(
    `| Detection with watchers, p50 / p95 (n=${String(CHANGES)}) | ${ms(percentile(w.latencies, 50))} / ${ms(percentile(w.latencies, 95))} | p95 <= 2 s |`,
  );
  console.log(
    `| Incremental graph build, p50 / p95 | ${ms(percentile(w.graphs, 50))} / ${ms(percentile(w.graphs, 95))} | p95 <= 500 ms |`,
  );

  // Idle: nothing changes. Machine-wide CPU (all processes, so Git child
  // processes count) minus a baseline taken with the service stopped.
  await new Promise((r) => setTimeout(r, 2000));
  const busy = await machineBusy(IDLE_MS);
  const rss = process.memoryUsage().rss;
  watched.svc.stop();
  await new Promise((r) => setTimeout(r, 1000));
  const baseline = await machineBusy(IDLE_MS);
  console.log(
    `| Idle CPU over ${String(IDLE_MS / 1000)} s, whole machine incl. Git processes, minus baseline | ${(busy - baseline).toFixed(2)} % (${busy.toFixed(2)} % with service, ${baseline.toFixed(2)} % baseline) | < 2 % (service + UI) |`,
  );
  console.log(
    `| Memory (service process RSS) | ${(rss / 2 ** 20).toFixed(0)} MiB | < 500 MB (service + browser) |`,
  );

  // Watchers off: reconciliation (5 s) alone.
  const unwatched = await start({ watch: false });
  const r = await detection(unwatched.svc, "r");
  console.log(
    `| Detection by reconciliation only, p50 / p95 | ${ms(percentile(r.latencies, 50))} / ${ms(percentile(r.latencies, 95))} | <= 7 s |`,
  );
  unwatched.svc.stop();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
