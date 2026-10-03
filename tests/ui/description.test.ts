import { describe, expect, it } from "vitest";
import type { GraphJson, GraphNodeJson } from "../../src/api/types.ts";
import { botanicalScene } from "../../src/ui/botanical.ts";
import { hillsideLayout } from "../../src/ui/hillside.ts";
import {
  gardenScene,
  LAYERS,
  sceneBounds,
  sceneOf,
  toDesign,
  type PlantInput,
} from "../../src/ui/scene/description.ts";
import { swaySprites } from "../../src/ui/sway.ts";
import { blendScenes } from "../../src/ui/transition.ts";

const node = (
  oid: string,
  x: number,
  y: number,
  refs: string[] = [],
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

const graphOf = (
  id: string,
  width = 60,
  height = 120,
  kind: "direct" | "collapsed" = "direct",
): GraphJson => ({
  id,
  revision: 1,
  window: { startMs: 0, endMs: 0, businessDates: [], timeZone: "UTC" },
  reachableCount: 2,
  completeness: {
    coherent: true,
    attempts: 1,
    shallow: false,
    grafts: false,
    missingTips: [],
  },
  revealed: [],
  nodes: [
    node(`${id}-tip`, 4, 20, ["main", "tag: v1"]),
    node(`${id}-root`, width - 4, height - 20),
  ],
  edges: [
    {
      child: `${id}-tip`,
      parent: `${id}-root`,
      kind,
      hidden: kind === "collapsed" ? 1234 : null,
      from: { x: 4, y: 20 },
      to: { x: width - 4, y: height - 20 },
    },
  ],
  tails: [],
  size: { width, height, lanes: 2, rows: 2 },
});

const slot = (index: number) => {
  const s = hillsideLayout(64)[index];
  if (!s) throw new Error(`no slot ${String(index)}`);
  return s;
};

const plants: PlantInput[] = [
  { id: "front", graph: graphOf("front"), slot: slot(60), wilting: false },
  { id: "back", graph: graphOf("back", 90), slot: slot(3), wilting: true },
  {
    id: "middle",
    graph: graphOf("middle", 60, 120, "collapsed"),
    slot: slot(27),
    wilting: false,
  },
];

describe("garden scene description", () => {
  it("is stable: the same inputs give an equal scene, sharing each plant's scene", () => {
    const a = gardenScene(plants, null);
    const b = gardenScene(
      plants.map((p) => ({ ...p })),
      null,
    );
    expect(b).toEqual(a);
    for (const [i, plant] of a.plants.entries())
      expect(b.plants[i]?.scene).toBe(plant.scene);
    for (const { graph } of plants)
      expect(sceneOf(graph)).toEqual(botanicalScene(graph));
    expect(a.layers).toEqual(LAYERS);
    expect([a.width, a.height]).toEqual([1920, 1080]);
  });

  it("does not change its inputs", () => {
    const before = structuredClone(plants);
    gardenScene(plants, "middle");
    expect(plants).toEqual(before);
  });

  it("stands each plant's lanes on its slot, at the slot's depth scale", () => {
    const scene = gardenScene(plants, null);
    for (const plant of scene.plants) {
      const input = plants.find((p) => p.id === plant.id);
      if (!input) throw new Error(plant.id);
      const base = toDesign(
        plant,
        input.graph.size.width / 2,
        input.graph.size.height,
      );
      expect(base.x).toBeCloseTo((input.slot.x / 100) * 1920, 9);
      expect(base.y).toBeCloseTo((input.slot.y / 100) * 1080, 9);
      // One graph pixel is `scale` design pixels.
      const right = toDesign(plant, input.graph.size.width / 2 + 10, 0);
      expect(right.x - base.x).toBeCloseTo(10 * input.slot.scale, 9);
      expect(plant.wilting).toBe(input.wilting);
    }
  });

  it("orders plants back to front, with the highlighted plant in front of all", () => {
    expect(gardenScene(plants, null).plants.map((p) => p.id)).toEqual([
      "back",
      "middle",
      "front",
    ]);
    const lit = gardenScene(plants, "back").plants;
    expect(lit.map((p) => p.id)).toEqual(["middle", "front", "back"]);
    expect(lit.map((p) => p.highlighted)).toEqual([false, false, true]);
  });

  it("keeps configuration order among plants in the same row", () => {
    // Three plants at one depth.
    const row = [slot(8), slot(9), slot(10)].map((s, i) => ({
      id: `r${String(i)}`,
      graph: graphOf(`r${String(i)}`),
      slot: { ...s, y: slot(8).y },
      wilting: false,
    }));
    expect(
      gardenScene([...row].reverse(), null).plants.map((p) => p.id),
    ).toEqual(["r2", "r1", "r0"]);
  });

  it("carries a collapsed stem's hidden-commit badge", () => {
    const middle = gardenScene(plants, null).plants.find(
      (p) => p.id === "middle",
    );
    expect(middle?.scene.badges.map((b) => b.text)).toEqual(["999+"]);
  });

  it("bounds every mark of a plant, swaying or growing", () => {
    for (const input of plants) {
      const scene = sceneOf(input.graph);
      const box = sceneBounds(scene, input.graph);
      const inside = (x: number, y: number) =>
        x >= box.x &&
        x <= box.x + box.width &&
        y >= box.y &&
        y <= box.y + box.height;
      expect(inside(0, 0)).toBe(true);
      expect(inside(input.graph.size.width, input.graph.size.height)).toBe(
        true,
      );
      const frame = blendScenes(null, scene, 1);
      for (let seconds = 0; seconds < 12; seconds += 0.25)
        for (const s of swaySprites(frame.sprites, seconds)) {
          // The corners of the turned cell.
          for (const [u, v] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ] as const) {
            const h = s.size / 2;
            const x =
              s.x + (u * Math.cos(s.rotate) - v * Math.sin(s.rotate)) * h;
            const y =
              s.y + (u * Math.sin(s.rotate) + v * Math.cos(s.rotate)) * h;
            expect(inside(x, y)).toBe(true);
          }
        }
      for (const b of frame.badges) {
        expect(inside(b.x - b.width / 2, b.y - 7)).toBe(true);
        expect(inside(b.x + b.width / 2, b.y + 7)).toBe(true);
      }
      for (const g of frame.grounds) {
        expect(inside(g.x - g.width / 2, g.y)).toBe(true);
        expect(inside(g.x + g.width / 2, g.y)).toBe(true);
      }
    }
  });
});
