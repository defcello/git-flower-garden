/**
 * What both tiers draw, in canvas pixels: the cover transform from design
 * space, sky bodies, and ground shadows. Only the shading of art differs
 * between tiers; everything here is computed once and drawn by each.
 */
import type { LightingState } from "../../src/environment/lighting.ts";
import type { Pixels } from "./art.ts";
import {
  CELLS,
  CLUSTERS,
  DESIGN,
  HORIZON,
  INSPECTION,
  STARS,
  skyPoint,
  type Sprite,
} from "./scene.ts";

export interface Transform {
  width: number;
  height: number;
  scale: number;
  ox: number;
  oy: number;
}

/** Cover the canvas, anchored at the bottom center like today's backdrop. */
export function transform(width: number, height: number): Transform {
  const scale = Math.max(width / DESIGN.width, height / DESIGN.height);
  return {
    width,
    height,
    scale,
    ox: (width - DESIGN.width * scale) / 2,
    oy: height - DESIGN.height * scale,
  };
}

export const toCanvas = (t: Transform, x: number, y: number) => ({
  x: t.ox + x * t.scale,
  y: t.oy + y * t.scale,
});

export interface Quad {
  /** Canvas rectangle. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source rectangle in texels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function layerQuad(t: Transform, art: Pixels): Quad {
  return {
    x: t.ox,
    y: t.oy,
    w: DESIGN.width * t.scale,
    h: DESIGN.height * t.scale,
    sx: 0,
    sy: 0,
    sw: art.width,
    sh: art.height,
  };
}

export function spriteQuads(
  t: Transform,
  atlas: Pixels,
  inspect: boolean,
): Quad[] {
  const cell = atlas.width / 2;
  const sprites: Sprite[] = CLUSTERS.flatMap((c) => c.sprites);
  if (inspect) sprites.push(...INSPECTION);
  return sprites.map((s) => {
    const [cx, cy] = CELLS[s.cell];
    const p = toCanvas(t, s.x - s.size / 2, s.y - s.size / 2);
    return {
      x: p.x,
      y: p.y,
      w: s.size * t.scale,
      h: s.size * t.scale,
      sx: cx * cell,
      sy: cy * cell,
      sw: cell,
      sh: cell,
    };
  });
}

export interface Shadow {
  x: number;
  y: number;
  /** Radii along and across the shadow, canvas pixels. */
  rx: number;
  ry: number;
  angle: number;
  alpha: number;
}

export function shadows(
  t: Transform,
  state: LightingState,
  inspect: boolean,
): Shadow[] {
  const s = state.shadow;
  if (s === null) return [];
  const bases = CLUSTERS.map((c) => ({ x: c.x, y: c.y, size: 1 }));
  if (inspect)
    for (const i of INSPECTION)
      bases.push({ x: i.x, y: i.y + i.size * 0.42, size: 2.4 });
  return bases.map((b) => {
    const length = Math.min(s.length, 5) * 16 * b.size;
    // Toward the viewer (z) reads as down the slope, foreshortened.
    const dx = s.x * length;
    const dy = s.z * length * 0.35;
    const p = toCanvas(t, b.x + dx / 2, b.y + 4 + dy / 2);
    return {
      x: p.x,
      y: p.y,
      rx: (18 * b.size + Math.hypot(dx, dy) / 2) * t.scale,
      ry: 7 * b.size * t.scale,
      angle: Math.atan2(dy, dx),
      alpha: 0.32 * state.sun.intensity,
    };
  });
}

export interface SkyBodies {
  horizonY: number;
  sun: { x: number; y: number; r: number; glow: number; alpha: number } | null;
  moon: {
    x: number;
    y: number;
    r: number;
    alpha: number;
    /** Direction to the Sun as lit from the viewer's side (x right, y up, z out). */
    s: [number, number, number];
  } | null;
  stars: { x: number; y: number; r: number; a: number }[];
}

export function skyBodies(t: Transform, state: LightingState): SkyBodies {
  const sunP = skyPoint(state.sun);
  const moonP = skyPoint(state.moon);
  const e = (state.moon.phaseDegrees * Math.PI) / 180;
  const limb = (state.moon.limbAngle * Math.PI) / 180;
  const side = Math.abs(Math.sin(e));
  const sun = toCanvas(t, sunP.x, sunP.y);
  const moon = toCanvas(t, moonP.x, moonP.y);
  return {
    horizonY: t.oy + DESIGN.height * HORIZON * t.scale,
    sun:
      state.sun.altitude > -1
        ? {
            ...sun,
            r: 22 * t.scale,
            glow: 150 * t.scale,
            alpha: Math.min(1, (state.sun.altitude + 1) / 2),
          }
        : null,
    moon:
      state.moon.altitude > -1
        ? {
            ...moon,
            r: 20 * t.scale,
            alpha:
              Math.min(1, (state.moon.altitude + 1) / 2) *
              (1 - 0.55 * state.sun.intensity),
            s: [Math.cos(limb) * side, Math.sin(limb) * side, -Math.cos(e)],
          }
        : null,
    stars:
      state.stars > 0
        ? STARS.map((s) => {
            const p = toCanvas(t, s.x, s.y);
            return { ...p, r: s.r * t.scale, a: s.a * state.stars };
          })
        : [],
  };
}

/** Lit fraction at a point on the Moon's disc (dx right, dy up, unit radius). */
export function moonLight(
  dx: number,
  dy: number,
  s: [number, number, number],
): number {
  const z = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const d = dx * s[0] + dy * s[1] + z * s[2];
  const t = Math.min(1, Math.max(0, (d + 0.04) / 0.08));
  // Earthshine keeps the dark side faintly visible.
  return 0.07 + 0.93 * t * t * (3 - 2 * t);
}

export const MOON_COLOR: [number, number, number] = [0.94, 0.93, 0.87];
