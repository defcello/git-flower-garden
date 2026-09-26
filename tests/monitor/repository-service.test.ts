import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/config.ts";
import { readSnapshot } from "../../src/git/snapshot.ts";
import { RepositoryService } from "../../src/monitor/repository-service.ts";
import { buildFixture } from "../fixtures/builder.ts";
import { gardenTour } from "../fixtures/demo.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

async function setup() {
  const dir = await tempDir();
  const fixture = await buildFixture(gardenTour, join(dir, "repo"));
  const result = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: [{ id: "tour", path: fixture.dir }],
    }),
    dir,
  );
  if (!result.ok) throw new Error("bad config");
  let now = Date.parse("2026-09-22T15:00:00-04:00");
  let failNext = false;
  let reads = 0;
  const service = new RepositoryService(result.config, {
    now: () => now,
    readSnapshot: async (path, options) => {
      reads++;
      await new Promise((r) => setTimeout(r, 20));
      if (failNext)
        throw new Error(
          "fatal: simulated failure for https://user:secret@example.invalid/x.git",
        );
      return readSnapshot(path, options);
    },
  });
  return {
    service,
    fixture,
    setNow: (iso: string) => (now = Date.parse(iso)),
    failNext: (v: boolean) => (failNext = v),
    reads: () => reads,
  };
}

describe("RepositoryService", () => {
  it("shares one read among concurrent refreshes", async () => {
    const t = await setup();
    const views = await Promise.all([
      t.service.refresh("tour"),
      t.service.refresh("tour"),
      t.service.refresh("tour"),
    ]);
    expect(t.reads()).toBe(1);
    expect(new Set(views.map((v) => v.revision))).toEqual(new Set([1]));
  });

  it("reuses the graph until the snapshot, window, minute, or reveal set changes", async () => {
    const t = await setup();
    await t.service.refresh("tour");
    const a = await t.service.graph("tour");
    expect(await t.service.graph("tour")).toBe(a);
    t.setNow("2026-09-22T15:00:30-04:00"); // same minute
    expect(await t.service.graph("tour")).toBe(a);
    t.setNow("2026-09-22T15:01:00-04:00");
    const b = await t.service.graph("tour");
    expect(b).not.toBe(a);
    expect(await t.service.graph("tour", [t.fixture.oid("a4")])).not.toBe(b);
    await t.service.refresh("tour");
    const c = await t.service.graph("tour");
    expect(c?.revision).toBe(2);
    // Next day: the window moves and the recent commits drop out.
    t.setNow("2026-09-24T09:00:00-04:00");
    const d = await t.service.graph("tour");
    expect(d?.graph.nodes.size).toBeLessThan(c?.graph.nodes.size ?? 0);
  });

  it("keeps the last good snapshot and reports stale, with credentials redacted", async () => {
    const t = await setup();
    await t.service.refresh("tour");
    t.failNext(true);
    const view = await t.service.refresh("tour");
    expect(view.status.state).toBe("stale");
    expect(view.status.diagnostic).toContain(
      "https://***@example.invalid/x.git",
    );
    expect(view.status.diagnostic).not.toContain("secret");
    expect(view.snapshot).not.toBeNull();
    expect(view.revision).toBe(1);
    expect((await t.service.graph("tour"))?.graph.nodes.size).toBeGreaterThan(
      0,
    );
    t.failNext(false);
    expect((await t.service.refresh("tour")).status.state).toBe("ready");
  });
});
