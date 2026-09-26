import { describe, expect, it } from "vitest";
import {
  historyWindow,
  type HistoryWindow,
} from "../../src/core/business-days.ts";
import {
  buildVisibleGraph,
  type GraphInput,
  type TopologyCommit,
  type VisibleGraph,
} from "../../src/core/visible-graph.ts";
import { toGitDate, type FixtureSpec } from "../../src/demo/builder.ts";
import { oldBranchHead, forkMerge } from "../../src/demo/fixtures.ts";
import { oracleAnchors } from "../oracle/best-common-ancestors.ts";
import { randomDag, seededRandom } from "../oracle/random-dag.ts";

const NY_WEEK = {
  businessDays: 2,
  weekdays: ["mon", "tue", "wed", "thu", "fri"] as const,
  timeZone: "America/New_York",
};

function specInput(spec: FixtureSpec, nowIso: string): GraphInput {
  const commits = new Map<string, TopologyCommit>(
    spec.commits.map((c) => [
      c.name,
      {
        parents: c.parents ?? [],
        committerTime: Number(toGitDate(c.committed).split(" ")[0]),
      },
    ]),
  );
  return {
    commits,
    heads: Object.entries(spec.branches).map(([name, target]) => ({
      id: `refs/heads/${name}`,
      commitOid: target,
    })),
    window: historyWindow(
      { ...NY_WEEK, weekdays: [...NY_WEEK.weekdays] },
      Date.parse(nowIso),
    ),
  };
}

const edgeList = (g: VisibleGraph) =>
  g.edges.map(
    (e) =>
      `${e.child}->${e.parent} ${e.kind}${e.kind === "direct" ? "" : ` ${String(e.hidden)}`}`,
  );

describe("buildVisibleGraph on demo fixtures", () => {
  it("oldBranchHead: keeps the old head and its base, compresses years of history", () => {
    // Monday 2026-09-21 afternoon: window starts Friday 2026-09-18 00:00.
    const g = buildVisibleGraph(
      specInput(oldBranchHead, "2026-09-21T15:00:00-04:00"),
    );
    expect(
      Object.fromEntries(
        [...g.nodes].map(([oid, n]) => [oid, n.reasons.sort()]),
      ),
    ).toEqual({
      recent2: ["head", "recent"],
      recent1: ["recent"],
      proto1: ["head"],
      ancient2: ["ancestor"],
    });
    expect(g.nodes.get("ancient2")?.anchorFor).toEqual(["proto1", "recent2"]);
    expect(edgeList(g)).toEqual([
      "proto1->ancient2 direct",
      "recent1->ancient2 collapsed 3", // ancient5, ancient4, ancient3
      "recent2->recent1 direct",
    ]);
    // History continues below ancient2 to the root commit ancient1.
    expect(g.tails).toEqual([
      { child: "ancient2", hidden: 1, boundary: false },
    ]);
    expect(g.reachableCount).toBe(8);
  });

  it("forkMerge on a quiet day later shows only the required skeleton", () => {
    // Two weeks later nothing is recent: heads and their base remain.
    const g = buildVisibleGraph(
      specInput(forkMerge, "2026-10-07T12:00:00-04:00"),
    );
    expect([...g.nodes.keys()].sort()).toEqual(["feat2", "merge"]);
    // feat2 is main's merge parent, and is itself the base of {main, trellis}.
    expect(g.nodes.get("feat2")?.reasons.sort()).toEqual(["ancestor", "head"]);
    expect(edgeList(g)).toEqual(["merge->feat2 direct"]);
    // The merge's first-parent history (trunk2, trunk1, root) is hidden: one path to a root.
    // feat2's history (feat1, trunk1, root) likewise.
    expect(g.tails).toEqual([
      { child: "feat2", hidden: 3, boundary: false },
      { child: "merge", hidden: 3, boundary: false },
    ]);
  });

  it("flags future-dated commits and marks worktree and inspection reasons", () => {
    const input = specInput(forkMerge, "2026-09-16T12:00:00-04:00");
    const g = buildVisibleGraph({
      ...input,
      worktreeHeads: ["trunk1"],
      reveal: ["root"],
    });
    expect(g.nodes.get("merge")?.futureDated).toBe(true); // committed 2026-09-21
    expect(g.nodes.get("trunk1")?.reasons).toContain("worktree");
    expect(g.nodes.get("root")?.reasons).toEqual(["inspection"]);
  });
});

/**
 * Independent oracle: enumerate every parent path explicitly (exponential,
 * small graphs only), following hidden commits until a visible one, a root,
 * or a missing object.
 */
function oracle(input: GraphInput, visible: Set<string>) {
  const commits = input.commits;
  const shallow = input.shallowBoundary ?? new Set<string>();
  const edges = new Map<string, number[]>(); // "child->parent kind" -> hidden counts per path
  const tails = new Map<string, number[]>(); // "child boundary" -> hidden counts per path
  const push = (map: Map<string, number[]>, key: string, n: number) =>
    map.set(key, [...(map.get(key) ?? []), n]);

  for (const child of visible) {
    const walk = (oid: string, hidden: number): void => {
      const parents = commits.get(oid)?.parents ?? [];
      if (hidden > 0 && parents.length === 0)
        push(tails, `${child} ${String(shallow.has(oid))}`, hidden);
      for (const p of parents) {
        if (!commits.has(p)) push(tails, `${child} true`, hidden);
        else if (visible.has(p))
          push(
            edges,
            `${child}->${p} ${hidden === 0 ? "direct" : "collapsed"}`,
            hidden,
          );
        else walk(p, hidden + 1);
      }
    };
    walk(child, 0);
  }
  const summarize = (counts: number[]) =>
    counts.length === 1 ? (counts[0] as number) : null;
  return {
    edges: [...edges]
      .map(([key, counts]) =>
        key.endsWith("direct") ? key : `${key} ${String(summarize(counts))}`,
      )
      .sort(),
    tails: [...tails]
      .map(([key, counts]) => `${key} ${String(summarize(counts))}`)
      .sort(),
  };
}

describe("agrees with a path-enumeration oracle", () => {
  it("on 1,500 random DAGs with missing objects, shallow boundaries, and random windows", () => {
    let collapsed = 0;
    let multi = 0;
    let missingTails = 0;
    for (let seed = 0; seed < 1500; seed++) {
      const random = seededRandom(seed * 7919);
      const dag = randomDag(seed, {
        commits: 2 + (seed % 22),
        heads: 1 + (seed % 5),
        mergeChance: 0.3,
        reach: 5,
      });
      const commits = new Map<string, TopologyCommit>();
      const shallow = new Set<string>();
      dag.names.forEach((name, i) => {
        let parents = dag.parents.get(name) ?? [];
        // Some commits are cut off by a shallow clone; their parents are unknown.
        if (random() < 0.05 && parents.length > 0) {
          shallow.add(name);
          parents = [];
        }
        commits.set(name, { parents, committerTime: 1_000_000 + i * 3600 });
      });
      // Some objects are missing entirely (never fetched).
      for (const name of dag.names)
        if (random() < 0.04 && !dag.heads.includes(name)) commits.delete(name);
      const heads = dag.heads.filter((h) => commits.has(h));
      const worktreeHeads = dag.names.filter(
        (n) => commits.has(n) && random() < 0.05,
      );
      const lastTime = 1_000_000 + (dag.names.length - 1) * 3600;
      const window: HistoryWindow = {
        startMs:
          (lastTime - Math.floor(random() * dag.names.length) * 3600) * 1000,
        endMs: lastTime * 1000,
        businessDates: [],
        timeZone: "UTC",
      };
      const input: GraphInput = {
        commits,
        shallowBoundary: shallow,
        heads: heads.map((h, i) => ({ id: `h${String(i)}`, commitOid: h })),
        worktreeHeads,
        window,
      };
      const g = buildVisibleGraph(input);

      // Mandatory set, computed independently.
      const parentMap = new Map(
        [...commits].map(([oid, c]) => [oid, c.parents]),
      );
      const reachable = new Set<string>();
      const visit = (oid: string): void => {
        if (reachable.has(oid) || !commits.has(oid)) return;
        reachable.add(oid);
        for (const p of commits.get(oid)?.parents ?? []) visit(p);
      };
      [...heads, ...worktreeHeads].forEach(visit);
      const expected = new Set<string>([
        ...heads,
        ...worktreeHeads,
        ...oracleAnchors(parentMap, heads).keys(),
      ]);
      for (const oid of reachable) {
        const t = (commits.get(oid) as TopologyCommit).committerTime * 1000;
        if (t >= window.startMs && t <= window.endMs) expected.add(oid);
      }
      expect([...g.nodes.keys()].sort(), `seed ${String(seed)}`).toEqual(
        [...expected].sort(),
      );

      const o = oracle(input, expected);
      expect(edgeList(g).sort(), `seed ${String(seed)}`).toEqual(o.edges);
      expect(
        g.tails
          .map((t) => `${t.child} ${String(t.boundary)} ${String(t.hidden)}`)
          .sort(),
        `seed ${String(seed)}`,
      ).toEqual(o.tails);

      collapsed += g.edges.filter((e) => e.kind === "collapsed").length;
      multi += g.edges.filter(
        (e) => e.kind === "collapsed" && e.hidden === null,
      ).length;
      missingTails += g.tails.filter((t) => t.boundary).length;
    }
    // Guard against a generator that never exercises the interesting cases.
    expect(collapsed).toBeGreaterThan(500);
    expect(multi).toBeGreaterThan(50);
    expect(missingTails).toBeGreaterThan(100);
  }, 60_000);
});

describe("named fixture cases (roadmap section 12)", () => {
  const window: HistoryWindow = {
    startMs: 1_000_000_000,
    endMs: 2_000_000_000,
    businessDates: [],
    timeZone: "UTC",
  };
  const commits = (entries: [string, string[], number][]) =>
    new Map<string, TopologyCommit>(
      entries.map(([oid, parents, t]) => [oid, { parents, committerTime: t }]),
    );

  it("keeps a recent ancestor below an old-dated child (timestamp inversion)", () => {
    // tip has a skewed, ancient clock; its parent is genuinely recent.
    const g = buildVisibleGraph({
      commits: commits([
        ["root", [], 100],
        ["recentParent", ["root"], 1_500_000],
        ["tip", ["recentParent"], 200],
      ]),
      heads: [{ id: "main", commitOid: "tip" }],
      window,
    });
    expect(g.nodes.get("recentParent")?.reasons).toEqual(["recent"]);
    expect(edgeList(g)).toEqual(["tip->recentParent direct"]);
  });

  it("shows several refs on one commit as one node", () => {
    const g = buildVisibleGraph({
      commits: commits([
        ["a", [], 100],
        ["b", ["a"], 200],
      ]),
      heads: [
        { id: "refs/heads/main", commitOid: "b" },
        { id: "refs/remotes/origin/main", commitOid: "b" },
      ],
      window,
    });
    expect([...g.nodes.keys()]).toEqual(["b"]);
    expect(g.nodes.get("b")?.reasons).toEqual(["head"]);
  });

  it("keeps every parent of an octopus merge in order", () => {
    const g = buildVisibleGraph({
      commits: commits([
        ["r", [], 1_100_000],
        ["p", ["r"], 1_200_000],
        ["q", ["r"], 1_200_001],
        ["s", ["r"], 1_200_002],
        ["o", ["p", "q", "s"], 1_300_000],
      ]),
      heads: [{ id: "main", commitOid: "o" }],
      window,
    });
    const fromOctopus = g.edges.filter((e) => e.child === "o");
    expect(fromOctopus.map((e) => [e.parent, e.parentIndexes])).toEqual([
      ["p", [0]],
      ["q", [1]],
      ["s", [2]],
    ]);
  });

  it("never connects unrelated histories", () => {
    const g = buildVisibleGraph({
      commits: commits([
        ["a1", [], 1_100_000],
        ["a2", ["a1"], 1_200_000],
        ["b1", [], 1_100_000],
        ["b2", ["b1"], 1_200_000],
      ]),
      heads: [
        { id: "a", commitOid: "a2" },
        { id: "b", commitOid: "b2" },
      ],
      window,
    });
    expect(edgeList(g)).toEqual(["a2->a1 direct", "b2->b1 direct"]);
    expect(
      [...g.nodes.values()].some((n) => n.reasons.includes("ancestor")),
    ).toBe(false);
  });
});
