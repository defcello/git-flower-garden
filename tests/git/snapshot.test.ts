import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { historyWindow } from "../../src/core/business-days.ts";
import {
  refLabels,
  snapshotGraphInput,
} from "../../src/core/snapshot-graph.ts";
import { buildVisibleGraph } from "../../src/core/visible-graph.ts";
import { readSnapshot } from "../../src/git/snapshot.ts";
import { buildFixture, fixtureGit } from "../fixtures/builder.ts";
import { gardenTour } from "../fixtures/demo.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

describe("readSnapshot end to end", () => {
  it("gardenTour through real Git: honest skeleton, compressed history, decorations", async () => {
    const fixture = await buildFixture(
      gardenTour,
      join(await tempDir(), "repo"),
    );
    const snapshot = await readSnapshot(fixture.dir, { now: () => 42 });
    expect(snapshot.completeness).toEqual({
      coherent: true,
      attempts: 1,
      shallow: false,
      grafts: false,
      missingTips: [],
    });
    expect(snapshot.capturedAt).toBe(42);

    // Tuesday afternoon: the window starts Monday 2026-09-21 00:00 EDT.
    const window = historyWindow(
      {
        businessDays: 2,
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        timeZone: "America/New_York",
      },
      Date.parse("2026-09-22T15:00:00-04:00"),
    );
    const graph = buildVisibleGraph(snapshotGraphInput(snapshot, window));
    const name = new Map([...fixture.oids].map(([n, oid]) => [oid, n]));
    const named = (oid: string) => name.get(oid) ?? oid;

    expect([...graph.nodes.keys()].map(named).sort()).toEqual(
      ["a2", "h1", "h2", "m1", "m2", "m3", "merge", "rock2", "t1", "t2"].sort(),
    );
    const collapsed = graph.edges
      .filter((e) => e.kind === "collapsed")
      .map((e) => `${named(e.child)}->${named(e.parent)} ${String(e.hidden)}`)
      .sort();
    expect(collapsed).toEqual(["m1->a2 4", "rock2->a2 1"]);
    expect(
      graph.tails.map((t) => `${named(t.child)} ${String(t.hidden)}`),
    ).toEqual(["a2 1"]);

    // Tags decorate visible commits; the old v0.9 target (a4) is not shown.
    const labels = refLabels(snapshot);
    expect(labels.get(fixture.oid("merge"))).toEqual(["tag: v1.0"]);
    expect(labels.get(fixture.oid("m3"))).toEqual(["main"]);
    expect(graph.nodes.has(fixture.oid("a4"))).toBe(false);
  });

  it("reports refs whose commits are unavailable and still reads the rest", async () => {
    const fixture = await buildFixture(
      gardenTour,
      join(await tempDir(), "repo"),
    );
    const bogus = "0123456789abcdef0123456789abcdef01234567";
    // A corrupt or partially copied repository: a loose ref to a missing commit.
    await writeFile(
      join(fixture.dir, ".git", "refs", "heads", "lost"),
      `${bogus}\n`,
    );
    const snapshot = await readSnapshot(fixture.dir);
    expect(snapshot.completeness.missingTips).toEqual([bogus]);
    expect(snapshot.topology.commits.has(fixture.oid("m3"))).toBe(true);
    expect(snapshot.topology.commits.size).toBe(gardenTour.commits.length);
  });

  it("includes worktree HEADs as graph input", async () => {
    const fixture = await buildFixture(
      gardenTour,
      join(await tempDir(), "repo"),
    );
    await fixtureGit(fixture.dir, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      join(await tempDir(), "wt"),
      fixture.oid("a4"),
    ]);
    const snapshot = await readSnapshot(fixture.dir);
    const input = snapshotGraphInput(
      snapshot,
      historyWindow(
        { businessDays: 1, weekdays: ["mon"], timeZone: "UTC" },
        Date.parse("2030-01-07T12:00:00Z"),
      ),
    );
    expect(input.worktreeHeads).toContain(fixture.oid("a4"));
    expect(
      buildVisibleGraph(input).nodes.get(fixture.oid("a4"))?.reasons,
    ).toContain("worktree");
  });
});
