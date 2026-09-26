/*
 * Watchers are hints and reconciliation is the backstop (roadmap section 5.2).
 * Each is shown to detect a change on its own: watchers with reconciliation
 * effectively off, and reconciliation with watchers off ("watcher misses an
 * event" in the section 12 fixture table).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/config.ts";
import { RepositoryService } from "../../src/monitor/repository-service.ts";
import { buildFixture, fixtureGit } from "../../src/demo/builder.ts";
import { forkMerge } from "../../src/demo/fixtures.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

async function service(options: {
  watch: boolean;
  reconcileMs: number;
  fullReconcileMs?: number;
}) {
  const dir = await tempDir();
  const fixture = await buildFixture(forkMerge, join(dir, "repo"));
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "UTC" },
      repositories: [{ id: "r", path: fixture.dir }],
    }),
    dir,
  );
  if (!parsed.ok) throw new Error("config");
  const svc = new RepositoryService(parsed.config, {
    background: true,
    watch: options.watch,
    cacheRoot: join(dir, "cache"),
    intervals: {
      reconcileMs: options.reconcileMs,
      debounceMs: 50,
      ...(options.fullReconcileMs === undefined
        ? {}
        : { fullReconcileMs: options.fullReconcileMs }),
    },
  });
  await svc.start();
  return { svc, fixture };
}

async function detect(
  svc: RepositoryService,
  change: () => Promise<unknown>,
): Promise<number> {
  const before = svc.view("r")?.revision ?? 0;
  const started = Date.now();
  await change();
  const changed = Date.now();
  for (;;) {
    if ((svc.view("r")?.revision ?? 0) > before) return Date.now() - changed;
    if (Date.now() - started > 20_000) throw new Error("change not detected");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("change detection", () => {
  it("watchers alone detect ref changes (reconciliation set to one hour)", async () => {
    const { svc, fixture } = await service({
      watch: true,
      reconcileMs: 3_600_000,
    });
    try {
      const latencies = [];
      latencies.push(
        await detect(svc, () => fixtureGit(fixture.dir, ["branch", "w1"])),
      );
      latencies.push(
        await detect(svc, () =>
          fixtureGit(fixture.dir, [
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "w2",
          ]),
        ),
      );
      latencies.push(
        await detect(svc, () =>
          fixtureGit(fixture.dir, ["pack-refs", "--all"]).then(() =>
            fixtureGit(fixture.dir, ["branch", "-D", "w1"]),
          ),
        ),
      );
      // Generous bound for slow CI machines; typical is a few hundred ms.
      for (const ms of latencies) expect(ms).toBeLessThan(10_000);
    } finally {
      svc.stop();
    }
  });

  it("reconciliation alone detects changes when watchers are unavailable", async () => {
    const { svc, fixture } = await service({ watch: false, reconcileMs: 300 });
    try {
      const ms = await detect(svc, () =>
        fixtureGit(fixture.dir, ["tag", "r1"]),
      );
      expect(ms).toBeLessThan(10_000);
    } finally {
      svc.stop();
    }
  });

  it("idle ticks start no Git process until the fingerprint changes; full reads still recur", async () => {
    const reads = (svc: RepositoryService) =>
      svc.diagnostics().find((d) => d.id === "r")?.timings.reads ?? 0;
    const quiet = await service({
      watch: false,
      reconcileMs: 100,
      fullReconcileMs: 60_000,
    });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      // Only the initial read (and at most one follow-up) despite ~15 ticks.
      expect(reads(quiet.svc)).toBeLessThanOrEqual(2);
      const before = reads(quiet.svc);
      await detect(quiet.svc, () =>
        fixtureGit(quiet.fixture.dir, ["branch", "q1"]),
      );
      expect(reads(quiet.svc)).toBeGreaterThan(before);
    } finally {
      quiet.svc.stop();
    }
    const backstop = await service({
      watch: false,
      reconcileMs: 100,
      fullReconcileMs: 300,
    });
    try {
      // Full reads recur every 300 ms even though nothing changes.
      const deadline = Date.now() + 20_000;
      while (reads(backstop.svc) < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(reads(backstop.svc)).toBeGreaterThanOrEqual(3);
    } finally {
      backstop.svc.stop();
    }
  });
});
