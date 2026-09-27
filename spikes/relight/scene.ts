/**
 * The spike's scene, in 1920×1080 design pixels (ADR 0018 "Resolution"):
 * two backdrop layers, a few plant clusters on the hill, and an optional
 * row of large sprites for close inspection.
 */
import { environmentSnapshot } from "../../src/environment/environment.ts";
import {
  lightingState,
  type LightingState,
} from "../../src/environment/lighting.ts";

export const DESIGN = { width: 1920, height: 1080 };
/** Where altitude 0 sits, as a fraction of the height: behind the far ridges. */
export const HORIZON = 0.5;

export type Cell = "coral" | "lavender" | "leaves" | "berry";
/** Atlas cells, in the 2×2 grid order of the prompt. */
export const CELLS: Record<Cell, [number, number]> = {
  coral: [0, 0],
  lavender: [1, 0],
  leaves: [0, 1],
  berry: [1, 1],
};

export interface Sprite {
  cell: Cell;
  /** Center, in design pixels. */
  x: number;
  y: number;
  size: number;
}

export interface Cluster {
  /** Base of the plant, where its shadow falls. */
  x: number;
  y: number;
  sprites: Sprite[];
}

function cluster(x: number, y: number, top: Cell, scale = 1): Cluster {
  const s = (n: number) => n * scale;
  return {
    x,
    y,
    sprites: [
      { cell: "leaves", x, y: y - s(20), size: s(78) },
      {
        cell: top,
        x: x + s(4),
        y: y - s(64),
        size: s(top === "berry" ? 58 : 84),
      },
    ],
  };
}

export const CLUSTERS: Cluster[] = [
  cluster(330, 812, "coral", 0.9),
  cluster(520, 760, "lavender", 0.85),
  cluster(700, 850, "berry", 1),
  cluster(880, 740, "coral", 0.8),
  cluster(1040, 900, "lavender", 1.1),
  cluster(1220, 770, "berry", 0.85),
  cluster(1400, 860, "coral", 1),
  cluster(1580, 790, "lavender", 0.9),
  cluster(1750, 880, "berry", 1),
];

/** Large sprites for judging the shading up close. */
export const INSPECTION: Sprite[] = (
  ["coral", "lavender", "leaves", "berry"] as const
).map((cell, i) => ({ cell, x: 560 + i * 270, y: 900, size: 250 }));

export interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

/** A seeded star field above the horizon, in design pixels. */
export const STARS: Star[] = (() => {
  let seed = 20240927;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: 140 }, () => ({
    x: random() * DESIGN.width,
    y: random() * DESIGN.height * HORIZON * 0.98,
    r: 0.6 + random() * 1.2,
    a: 0.35 + random() * 0.65,
  }));
})();

/** Screen position of a sky body in design pixels, as in src/ui/sky.ts. */
export function skyPoint(body: { u: number; altitude: number }) {
  return {
    x: DESIGN.width * (0.04 + 0.92 * body.u),
    y: DESIGN.height * HORIZON * (1 - Math.max(-10, body.altitude) / 90),
  };
}

// ---------------------------------------------------------------------------
// Software-tier keyframes: authored once, on a day that is none of the
// previews (the March equinox in the Blue Ridge), so the comparison is fair:
// keyframes do not know the season, the latitude, or where the Sun really is.

const BLUE_RIDGE = {
  latitude: 35.5951,
  longitude: -82.5515,
  elevationMeters: 650,
};

export const KEYFRAMES = [
  { name: "dawn", time: "2024-03-20T12:10Z" },
  { name: "day", time: "2024-03-20T17:37Z" },
  { name: "dusk", time: "2024-03-20T23:15Z" },
  { name: "night", time: "2024-03-25T05:00Z" },
] as const;

export type KeyframeName = (typeof KEYFRAMES)[number]["name"];

export const keyframeStates: LightingState[] = KEYFRAMES.map((k) =>
  lightingState(
    environmentSnapshot(new Date(k.time), BLUE_RIDGE, "America/New_York"),
  ),
);

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Blend weights for [dawn, day, dusk, night], by Sun altitude and side. */
export function keyframeWeights(
  state: LightingState,
): [number, number, number, number] {
  const altitude = state.sun.altitude;
  const day = smoothstep(4, 22, altitude);
  const twilight = (1 - day) * smoothstep(-10, -1, altitude);
  const night = 1 - day - twilight;
  return state.rising ? [twilight, day, 0, night] : [0, day, twilight, night];
}
