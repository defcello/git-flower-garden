/*
 * Serve demo fixtures for browser tests and manual viewing:
 *
 *   node tests/e2e/fixture-server.ts [port]
 *
 * Builds real Git repositories in a temporary directory, pins the clock to
 * Tuesday 2026-09-22 15:00 EDT, reconciles every second, and prints the
 * fixture directory so tests can change repositories while the UI watches.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { startApp } from "../../src/server/app.ts";
import { buildFixture, fixtureGit } from "../../src/demo/builder.ts";
import { crissCross, forkMerge, artProof } from "../../src/demo/fixtures.ts";

export const FIXTURE_NOW = Date.parse("2026-09-22T15:00:00-04:00");

const port = Number(process.argv[2] ?? 4790);
// Browser tests pass a directory so they can change repositories while the UI watches.
const given = process.env.GARDEN_E2E_ROOT;
const root = given ?? (await mkdtemp(join(tmpdir(), "git-garden-e2e-")));
if (given) await mkdir(given, { recursive: true });
const repo = (name: string) => join(root, name);

await buildFixture(artProof, repo("garden tour"));
await buildFixture(forkMerge, repo("fork-merge"));
await buildFixture(crissCross, repo("criss-cross"));
// Two refs on one commit, and a worktree marker.
await fixtureGit(repo("fork-merge"), ["branch", "release", "main"]);
await fixtureGit(repo("fork-merge"), [
  "worktree",
  "add",
  "--quiet",
  "--detach",
  repo("fork-merge-wt"),
  "trellis",
]);
await mkdir(repo("empty"));
await fixtureGit(root, ["init", "--quiet", repo("empty")]);
// Many plots so the garden scrolls.
for (let i = 0; i < 4; i++)
  await buildFixture(forkMerge, repo(`extra-${String(i)}`));

const result = parseConfig(
  JSON.stringify({
    version: 1,
    history: { timeZone: "America/New_York" },
    monitor: { localReconcileSeconds: 1 },
    repositories: [
      { id: "tour", label: "Garden tour", path: "garden tour" },
      { id: "fork", label: "Fork and merge", path: "fork-merge" },
      { id: "criss", label: "Criss-cross", path: "criss-cross" },
      { id: "empty", label: "Empty repository", path: "empty" },
      { id: "missing", label: "Missing path", path: "does-not-exist" },
      ...[0, 1, 2, 3].map((i) => ({
        id: `extra-${String(i)}`,
        label: `Extra ${String(i)}`,
        path: `extra-${String(i)}`,
      })),
    ],
  }),
  root,
);
if (!result.ok) throw new Error(JSON.stringify(result.errors));

const app = await startApp(result.config, {
  now: () => FIXTURE_NOW,
  // Never touch the real per-user cache from tests.
  cacheRoot: join(root, ".git-garden-cache"),
  port,
  uiDir: resolve(import.meta.dirname, "../../dist/ui"),
});
console.log(`fixtures: ${root}`);
console.log(`listening: ${app.url}`);

const stop = async () => {
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
