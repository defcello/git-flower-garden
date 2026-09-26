import { describe, expect, it } from "vitest";
import {
  selectAncestorAnchors,
  type AncestorAnchor,
  type ParentMap,
} from "../../src/core/ancestor-anchors.ts";
import { buildFixture, type FixtureSpec } from "../fixtures/builder.ts";
import { demoFixtures } from "../fixtures/demo.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";
import { oracleAnchors } from "../oracle/best-common-ancestors.ts";
import { gitAnchors } from "../oracle/git-merge-bases.ts";
import { dagToFixture, randomDag } from "../oracle/random-dag.ts";

const tempDir = useTempDirs();

/** Build a parent map from `child: parent1 parent2` lines. */
function graph(...lines: string[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const line of lines) {
    const [child, rest = ""] = line.split(":");
    parents.set((child as string).trim(), rest.split(" ").filter(Boolean));
  }
  return parents;
}

function asRecord(
  anchors: readonly AncestorAnchor[],
): Record<string, string[]> {
  return Object.fromEntries(anchors.map((a) => [a.oid, [...a.heads]]));
}

function oracleRecord(
  parents: ParentMap,
  heads: string[],
): Record<string, string[]> {
  const result = oracleAnchors(parents, heads);
  return Object.fromEntries(
    [...result.keys()]
      .sort()
      .map((oid) => [oid, [...(result.get(oid) ?? [])].sort()]),
  );
}

function specToParents(spec: FixtureSpec): Map<string, string[]> {
  return new Map(spec.commits.map((c) => [c.name, [...(c.parents ?? [])]]));
}

describe("selectAncestorAnchors: specified cases", () => {
  it("returns nothing for fewer than two distinct heads", () => {
    const parents = graph("a:", "b: a");
    expect(selectAncestorAnchors(parents, [])).toEqual([]);
    expect(selectAncestorAnchors(parents, ["b"])).toEqual([]);
    expect(selectAncestorAnchors(parents, ["b", "b"])).toEqual([]);
  });

  it("selects the fork point of two diverged heads", () => {
    const parents = graph("r:", "f: r", "x: f", "y: f");
    expect(asRecord(selectAncestorAnchors(parents, ["x", "y"]))).toEqual({
      f: ["x", "y"],
    });
  });

  it("selects an older head that is an ancestor of another head", () => {
    const parents = graph("a:", "b: a", "c: b");
    expect(asRecord(selectAncestorAnchors(parents, ["a", "c"]))).toEqual({
      a: ["a", "c"],
    });
  });

  it("gives disconnected histories no invented common root", () => {
    const parents = graph("a1:", "a2: a1", "b1:", "b2: b1");
    expect(selectAncestorAnchors(parents, ["a2", "b2"])).toEqual([]);
  });

  it("keeps both bases of a criss-cross merge", () => {
    const parents = graph(
      "b:",
      "l1: b",
      "r1: b",
      "lm: l1 r1",
      "rm: r1 l1",
      "l2: lm",
      "r2: rm",
    );
    expect(asRecord(selectAncestorAnchors(parents, ["l2", "r2"]))).toEqual({
      l1: ["l2", "r2"],
      r1: ["l2", "r2"],
    });
  });

  it("finds a three-head base that no pair of heads has as its merge base", () => {
    // Each pair shares a different newer commit; only the triple needs r.
    const parents = graph(
      "r:",
      "x: r",
      "y: r",
      "z: r",
      "A: x y",
      "B: y z",
      "C: x z",
    );
    expect(asRecord(selectAncestorAnchors(parents, ["A", "B", "C"]))).toEqual({
      r: ["A", "B", "C"],
      x: ["A", "C"],
      y: ["A", "B"],
      z: ["B", "C"],
    });
  });

  it("represents octopus merges without losing any parent", () => {
    const parents = graph("r:", "p: r", "q: r", "s: r", "o: p q s", "t: s");
    expect(asRecord(selectAncestorAnchors(parents, ["o", "t"]))).toEqual({
      s: ["o", "t"],
    });
  });

  it("treats missing parents as a history boundary, not an error", () => {
    const parents = graph("x: gone", "y: x", "z: x");
    expect(asRecord(selectAncestorAnchors(parents, ["y", "z"]))).toEqual({
      x: ["y", "z"],
    });
  });

  it("rejects heads outside the graph and cyclic graphs", () => {
    expect(() => selectAncestorAnchors(graph("a:"), ["a", "nope"])).toThrow(
      /not in the commit graph/,
    );
    expect(() =>
      selectAncestorAnchors(graph("a: b", "b: a", "c: a"), ["a", "c"]),
    ).toThrow(/cycle/);
  });

  it("handles more heads than one 32-bit word", () => {
    // 40 heads on one line of history: every head except the newest is a base.
    const lines = ["h0:"];
    for (let i = 1; i < 40; i++) lines.push(`h${String(i)}: h${String(i - 1)}`);
    const heads = lines.map((line) => line.split(":")[0] as string);
    const anchors = selectAncestorAnchors(graph(...lines), heads);
    expect(anchors.map((a) => a.oid).sort()).toEqual(heads.slice(0, 39).sort());
    expect(anchors.find((a) => a.oid === "h0")?.heads).toHaveLength(40);
    expect(anchors.find((a) => a.oid === "h38")?.heads).toEqual(["h38", "h39"]);
  });
});

describe("selectAncestorAnchors agrees with the exhaustive oracle", () => {
  it("on the four demo fixtures", () => {
    for (const spec of Object.values(demoFixtures)) {
      const parents = specToParents(spec);
      const heads = Object.values(spec.branches);
      expect(
        asRecord(selectAncestorAnchors(parents, heads)),
        spec.description,
      ).toEqual(oracleRecord(parents, heads));
    }
  });

  it("on 2,000 seeded random DAGs (anchors and head subsets)", () => {
    let nonEmpty = 0;
    let multiBase = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const dag = randomDag(seed, {
        commits: 1 + (seed % 60),
        heads: 1 + (seed % 10),
        rootChance: [0, 0.03, 0.15][seed % 3] as number,
        mergeChance: [0.1, 0.3, 0.5][seed % 3] as number,
        reach: [3, 8, 30][(seed >> 2) % 3] as number,
      });
      const actual = asRecord(selectAncestorAnchors(dag.parents, dag.heads));
      expect(actual, `seed ${String(seed)}`).toEqual(
        oracleRecord(dag.parents, dag.heads),
      );
      if (Object.keys(actual).length > 0) nonEmpty++;
      if (Object.keys(actual).length > 1) multiBase++;
    }
    // Guard against a generator that only produces trivial graphs.
    expect(nonEmpty).toBeGreaterThan(1500);
    expect(multiBase).toBeGreaterThan(1000);
  });
});

describe("selector and oracle agree with git merge-base", () => {
  it.each(Object.entries(demoFixtures))("demo fixture %s", async (_, spec) => {
    const fixture = await buildFixture(spec, await tempDir());
    const heads = Object.values(spec.branches).map((name) => fixture.oid(name));
    const oidParents = new Map(
      spec.commits.map((c) => [
        fixture.oid(c.name),
        (c.parents ?? []).map((p) => fixture.oid(p)),
      ]),
    );
    const selected = selectAncestorAnchors(oidParents, heads).map((a) => a.oid);
    expect(selected).toEqual(
      [...(await gitAnchors(fixture.dir, heads))].sort(),
    );
    expect(selected).toEqual(
      [...oracleAnchors(oidParents, heads).keys()].sort(),
    );
  });

  it("on 12 seeded random repositories", async () => {
    for (let seed = 100; seed < 112; seed++) {
      const dag = randomDag(seed, {
        commits: 30,
        heads: 2 + (seed % 4),
        mergeChance: 0.35,
      });
      const fixture = await buildFixture(
        dagToFixture(dag, `random ${String(seed)}`),
        await tempDir(),
      );
      const oidParents = new Map(
        dag.names.map((name) => [
          fixture.oid(name),
          (dag.parents.get(name) ?? []).map((p) => fixture.oid(p)),
        ]),
      );
      const heads = dag.heads.map((name) => fixture.oid(name));
      const selected = selectAncestorAnchors(oidParents, heads).map(
        (a) => a.oid,
      );
      expect(selected, `seed ${String(seed)}`).toEqual(
        [...(await gitAnchors(fixture.dir, heads))].sort(),
      );
    }
  }, 120_000);
});
