/*
 * Roadmap P2-B fidelity rules for the botanical scene: taper by branch flow
 * (forks thinner, merges wider, lower thicker, clamped), exact endpoints,
 * stable depth order and seeds, and transitions that settle exactly.
 */
import { describe, expect, it } from "vitest";
import type {
  GraphEdgeJson,
  GraphJson,
  GraphNodeJson,
} from "../../src/api/types.ts";
import {
  botanicalScene,
  branchFlow,
  MAX_WIDTH,
  MIN_WIDTH,
  stemWidth,
} from "../../src/ui/botanical.ts";
import { blendScenes } from "../../src/ui/transition.ts";

function node(oid: string, x: number, y: number, refs: string[] = []) {
  return {
    oid,
    x,
    y,
    refs,
    lane: 0,
    row: 0,
    reasons: ["head"],
    anchorFor: [],
    futureDated: false,
    boundary: false,
    subject: oid,
    message: oid,
    parents: [],
    author: null,
    committer: null,
    worktrees: [],
  } satisfies GraphNodeJson;
}

function graph(
  nodes: GraphNodeJson[],
  links: [string, string][],
  tails: GraphJson["tails"] = [],
): GraphJson {
  const at = new Map(nodes.map((n) => [n.oid, n]));
  const edges: GraphEdgeJson[] = links.map(([child, parent]) => {
    const c = at.get(child);
    const p = at.get(parent);
    if (!c || !p) throw new Error("fixture");
    return {
      child,
      parent,
      kind: "direct",
      hidden: 0,
      from: { x: c.x, y: c.y },
      to: { x: p.x, y: p.y },
    };
  });
  return {
    id: "rules",
    revision: 1,
    window: { startMs: 0, endMs: 0, businessDates: [], timeZone: "UTC" },
    reachableCount: nodes.length,
    completeness: {
      coherent: true,
      attempts: 1,
      shallow: false,
      grafts: false,
      missingTips: [],
    },
    revealed: [],
    nodes,
    edges,
    tails,
    size: { width: 200, height: 400, lanes: 4, rows: nodes.length },
  };
}

const widthOf = (g: GraphJson, key: string) => {
  const stem = botanicalScene(g).stems.find((s) => s.key === key);
  if (!stem) throw new Error(`no stem ${key}`);
  return stem.width;
};

// Two branches fork from p; p continues down to the root r.
const fork = graph(
  [
    node("a", 0, 0, ["main"]),
    node("b", 40, 0, ["topic"]),
    node("p", 0, 100),
    node("r", 0, 200),
  ],
  [
    ["a", "p"],
    ["b", "p"],
    ["p", "r"],
  ],
);

// A tip t above a merge m of two lines l1, l2 that share the root r.
const merge = graph(
  [
    node("t", 0, 0, ["main"]),
    node("m", 0, 60),
    node("l1", 0, 140),
    node("l2", 40, 140),
    node("r", 0, 220),
  ],
  [
    ["t", "m"],
    ["m", "l1"],
    ["m", "l2"],
    ["l1", "r"],
    ["l2", "r"],
  ],
);

describe("branch flow", () => {
  it("is conserved: every tip contributes 1 and the root carries all of it", () => {
    expect(branchFlow(fork).get("r")).toBe(2);
    expect(branchFlow(fork).get("a")).toBe(1);
    expect(branchFlow(merge).get("m")).toBe(1);
    expect(branchFlow(merge).get("l1")).toBe(0.5);
    expect(branchFlow(merge).get("r")).toBe(1);
  });
});

describe("taper", () => {
  it("a fork's branches are thinner than the stem they split from", () => {
    expect(widthOf(fork, "a>p")).toBeLessThan(widthOf(fork, "p>r"));
    expect(widthOf(fork, "b>p")).toBeLessThan(widthOf(fork, "p>r"));
  });

  it("a merged stem is wider than each incoming continuation", () => {
    expect(widthOf(merge, "t>m")).toBeGreaterThan(widthOf(merge, "m>l1"));
    expect(widthOf(merge, "t>m")).toBeGreaterThan(widthOf(merge, "m>l2"));
  });

  it("is generally thicker lower down", () => {
    for (const flow of [0.5, 1, 3])
      expect(stemWidth(flow, 300, 400)).toBeGreaterThan(
        stemWidth(flow, 10, 400),
      );
  });

  it("is clamped: a huge merge never becomes an unreadable trunk", () => {
    const tips = Array.from({ length: 200 }, (_, i) =>
      node(`tip${String(i)}`, i, 0, [`b${String(i)}`]),
    );
    const huge = graph(
      [...tips, node("root", 0, 300)],
      tips.map((t) => [t.oid, "root"]),
    );
    expect(branchFlow(huge).get("root")).toBe(200);
    for (const stem of botanicalScene(huge).stems) {
      expect(stem.width).toBeLessThanOrEqual(MAX_WIDTH);
      expect(stem.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    }
    expect(stemWidth(1e6, 400, 400)).toBe(MAX_WIDTH);
    expect(stemWidth(0, 0, 400)).toBe(MIN_WIDTH);
  });
});

describe("fidelity", () => {
  it("draws exactly one stem per edge and tail, ending at the edge's own endpoints", () => {
    const g = graph(
      [node("a", 0, 0), node("b", 60, 90), node("c", 0, 180)],
      [
        ["a", "b"],
        ["b", "c"],
      ],
      [
        {
          child: "c",
          hidden: 4,
          boundary: false,
          from: { x: 0, y: 180 },
          to: { x: 0, y: 230 },
        },
      ],
    );
    const scene = botanicalScene(g);
    expect(scene.stems.map((s) => s.key).sort()).toEqual(
      ["a>b", "b>c", "c>tail"].sort(),
    );
    for (const edge of g.edges) {
      const stem = scene.stems.find(
        (s) => s.key === `${edge.child}>${edge.parent}`,
      );
      const points = [
        ...(stem?.path ?? "").matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g),
      ].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      // Outline: left side 0..n, then right side n..0.
      const n = points.length / 2 - 1;
      const mid = (i: number, j: number) => ({
        x: ((points[i]?.x ?? NaN) + (points[j]?.x ?? NaN)) / 2,
        y: ((points[i]?.y ?? NaN) + (points[j]?.y ?? NaN)) / 2,
      });
      const start = mid(0, points.length - 1);
      const end = mid(n, n + 1);
      expect(start.x).toBeCloseTo(edge.from.x, 1);
      expect(start.y).toBeCloseTo(edge.from.y, 1);
      expect(end.x).toBeCloseTo(edge.to.x, 1);
      expect(end.y).toBeCloseTo(edge.to.y, 1);
    }
  });

  it("orders stems by depth deterministically: thinner behind thicker", () => {
    const first = botanicalScene(fork).stems.map((s) => s.key);
    expect(
      botanicalScene(structuredClone(fork)).stems.map((s) => s.key),
    ).toEqual(first);
    const widths = botanicalScene(fork).stems.map((s) => s.width);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
  });

  it("seeds leaf variants by commit and flower variants by ref, not by position", () => {
    const moved = structuredClone(fork);
    for (const n of moved.nodes) {
      n.x += 17;
      n.y += 5;
    }
    const before = botanicalScene(fork).sprites;
    const after = botanicalScene(moved).sprites;
    for (const sprite of before) {
      const same = after.find((s) => s.key === sprite.key);
      expect(same?.kind).toBe(sprite.kind);
      expect(same?.rotate).toBe(sprite.rotate);
      expect(same?.flip).toBe(sprite.flip);
    }
  });

  it("gives every tag its own fruit (up to three per commit)", () => {
    const g = graph([node("a", 0, 0, ["tag: v1", "tag: v2", "main"])], []);
    const fruit = botanicalScene(g).sprites.filter((s) => s.kind === 3);
    expect(fruit.map((s) => s.key).sort()).toEqual([
      "fruit:tag: v1",
      "fruit:tag: v2",
    ]);
  });
});

describe("transitions", () => {
  const before = graph(
    [node("a", 0, 0, ["main"]), node("old", 40, 100)],
    [["a", "old"]],
  );
  const after = graph(
    [node("b", 20, 0, ["main"]), node("a", 0, 60), node("old", 40, 140)],
    [
      ["b", "a"],
      ["a", "old"],
    ],
  );
  const from = botanicalScene(before);
  const to = botanicalScene(after);

  it("settles exactly on the new scene, with nothing removed left behind", () => {
    const settled = blendScenes(from, to, 1);
    expect(settled.stems.map((s) => s.key)).toEqual(to.stems.map((s) => s.key));
    expect(settled.sprites.map(({ key, x, y }) => ({ key, x, y }))).toEqual(
      to.sprites.map(({ key, x, y }) => ({ key, x, y })),
    );
    for (const item of [...settled.stems, ...settled.sprites, ...settled.knots])
      expect(item.alpha).toBe(1);
    expect(blendScenes(null, to, 0)).toEqual(settled);
  });

  it("grows new marks in and moves a ref's flower to its new commit", () => {
    const halfway = blendScenes(from, to, 0.5);
    const grown = halfway.stems.find((s) => s.key === "b>a");
    expect(grown?.alpha).toBeGreaterThan(0);
    expect(grown?.alpha).toBeLessThan(1);
    // "main" moved from a (x 0) to the new commit b (x 20): its flower
    // glides between them, fully visible.
    const flower = halfway.sprites.find((s) => s.key === "flower:main");
    expect(flower?.alpha).toBe(1);
    expect(flower?.x).toBeGreaterThan(0);
    expect(flower?.x).toBeLessThan(20);
    const leaf = halfway.sprites.find((s) => s.key === "leaf:a");
    expect(leaf?.y).toBeGreaterThan(4);
    expect(leaf?.y).toBeLessThan(64);
    const newLeaf = halfway.sprites.find((s) => s.key === "leaf:b");
    expect(newLeaf?.scale).toBeGreaterThan(0.4);
    expect(newLeaf?.scale).toBeLessThan(1);
  });

  it("fades removed history out", () => {
    const shrinking = blendScenes(to, from, 0.5);
    const removed = shrinking.stems.find((s) => s.key === "b>a");
    expect(removed?.alpha).toBeGreaterThan(0);
    expect(removed?.alpha).toBeLessThan(1);
    expect(blendScenes(to, from, 1).stems.find((s) => s.key === "b>a")).toBe(
      undefined,
    );
  });
});
