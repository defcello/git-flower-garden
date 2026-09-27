import { expect, it } from "vitest";
import type { GraphJson, GraphNodeJson } from "../../src/api/types.ts";
import { botanicalScene } from "../../src/ui/botanical.ts";

const node = (
  oid: string,
  x: number,
  y: number,
  refs: string[],
): GraphNodeJson => ({
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
});
const graph: GraphJson = {
  id: "proof",
  revision: 1,
  window: { startMs: 0, endMs: 0, businessDates: [], timeZone: "UTC" },
  reachableCount: 3,
  completeness: {
    coherent: true,
    attempts: 1,
    shallow: false,
    grafts: false,
    missingTips: [],
  },
  revealed: [],
  nodes: [
    node("a", 30, 30, ["main", "release", "tag: v1"]),
    node("b", 60, 80, []),
    node("unrelated", 100, 100, []),
  ],
  edges: [
    {
      child: "a",
      parent: "b",
      kind: "collapsed",
      hidden: 3,
      from: { x: 30, y: 30 },
      to: { x: 60, y: 80 },
    },
  ],
  tails: [],
  size: { width: 150, height: 150, lanes: 3, rows: 3 },
};

it("decorates a disconnected graph without inventing connections and preserves marked ancestry", () => {
  const before = structuredClone(graph);
  const scene = botanicalScene(graph);
  expect(graph).toEqual(before);
  expect(scene.stems).toHaveLength(1);
  expect(scene.stems[0]?.path).toMatch(/^M30 30 .*60 80$/);
  expect(scene.stems[0]?.dashed).toBe(true);
  expect(scene.sprites.filter((s) => s.kind === 2)).toHaveLength(3);
  expect(scene.sprites.filter((s) => s.kind === 3)).toHaveLength(1);
  expect(scene.sprites.filter((s) => s.kind < 2)).toHaveLength(2);
});

it("a ref carries its flower family when its target moves; ref ordering has no effect", () => {
  const original = botanicalScene(graph).sprites.filter((s) => s.kind < 2);
  const moved = structuredClone(graph);
  const first = moved.nodes[0];
  if (!first) throw new Error("missing fixture node");
  first.oid = "new-target";
  first.x += 50;
  first.y += 50;
  first.refs.reverse();
  const flowers = botanicalScene(moved).sprites.filter((s) => s.kind < 2);
  expect(flowers.map((s) => s.kind)).toEqual(original.map((s) => s.kind));
  expect(flowers.map((s) => s.x)).toEqual(original.map((s) => s.x + 50));
});
