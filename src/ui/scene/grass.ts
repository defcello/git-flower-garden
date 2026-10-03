/*
 * The hill's grass (ADR 0021): Codex-painted tufts planted over the ground
 * layer, each bending with the wind about where it grows. Pure, so the
 * planting and any moment of the wind are testable; the tiers draw it
 * (GardenCanvas.tsx, plants-gpu.ts), interleaved with the plants by depth.
 *
 * Tufts are planted in rows that follow the hill's contour, from the crest
 * (small, far) to the bottom edge (large, near), each spaced in proportion
 * to its size and closer toward the viewer, so the grass looks about as
 * thick at every depth. A tuft bends downwind as the wind blows, its
 * blades curving along an arc that keeps their length (tuftBend): by a
 * steady angle for the wind's speed, and further as the waves of its gusts
 * roll past (wind-field.ts), springing back in the lulls between. Each
 * tuft has its own size, height, stiffness, and a moment's delay, so no
 * two move quite alike.
 */
import { seeded } from "../botanical.ts";
import { CREST, CREST_STEP } from "./crest.ts";
import { DESIGN } from "./view.ts";
import {
  gustEnvelope,
  siteWave,
  waveSite,
  waveSpeed,
  windGust,
  windHeading,
  type WaveSite,
  type WindField,
} from "./wind-field.ts";

export interface Tuft {
  /** Where it grows from, in design pixels. */
  x: number;
  y: number;
  /** The drawn size of its atlas cell, in design pixels. */
  size: number;
  /** Atlas cell, 0..3 (2×2, row by row). */
  kind: number;
  /** Drawn mirrored, from the mirrored atlas. */
  flip: boolean;
  /** Seeded 0..1, for its own flutter. */
  seed: number;
  /** Its height, relative to its width: 0.85..1.2. */
  stretch: number;
  /** How far the gusts bend it, relative to the others: 0.8..1.2. */
  stiff: number;
  /** Seconds it answers the gusts late (its own inertia): 0..0.15. */
  delay: number;
  /** Its place in the wind field, made once (waveSite); else made per pose. */
  site?: WaveSite;
}

/** Rows of a tuft as the GPU draws it (a strip): enough to curve smoothly. */
export const GRASS_ROWS = 6;

/** The relit grass atlas: 2×2 cells of 256 pixels, as the sprites'. */
export const GRASS_ATLAS = 512;

/** Where each tuft grows from in its cell, as fractions (measured). */
export const TUFT_BASE: readonly { x: number; y: number }[] = [
  { x: 0.515, y: 0.998 },
  { x: 0.521, y: 0.998 },
  { x: 0.548, y: 0.944 },
  { x: 0.523, y: 0.944 },
];

/**
 * What each tuft covers of its cell, as fractions (left, top, right,
 * bottom; measured, with a little room): both tiers draw only this, not
 * the whole cell, so its transparent margins cost no fill.
 */
export const TUFT_RECT: readonly (readonly [number, number, number, number])[] =
  [
    [0.07, 0.28, 0.97, 1],
    [0.04, 0.065, 0.96, 1],
    [0.04, 0.195, 1, 0.96],
    [0, 0.03, 0.945, 0.96],
  ];

/**
 * Share of each kind: short dense, tall, broad, seeding. Mostly slender:
 * many small round dense tufts read as blobs, not as grass.
 */
const KIND_WEIGHTS = [0.22, 0.38, 0.1, 0.3];

/** Cell size of a tuft at the crest and at the bottom edge, design pixels. */
const SIZE_FAR = 10;
const SIZE_NEAR = 88;

/** The crest's height at design `x`. */
export function crestAt(x: number): number {
  const f = Math.min(CREST.length - 1, Math.max(0, x / CREST_STEP));
  const i = Math.floor(f);
  const a = CREST[i] ?? 0;
  const b = CREST[Math.min(CREST.length - 1, i + 1)] ?? a;
  return a + (b - a) * (f - i);
}

/** A tuft's size at depth `d` (0 at the crest, 1 at the bottom edge). */
export function tuftSize(d: number): number {
  return SIZE_FAR + (SIZE_NEAR - SIZE_FAR) * Math.pow(Math.max(0, d), 1.6);
}

function pick(r: number): number {
  let sum = 0;
  for (let k = 0; k < KIND_WEIGHTS.length; k++) {
    sum += KIND_WEIGHTS[k] ?? 0;
    if (r < sum) return k;
  }
  return KIND_WEIGHTS.length - 1;
}

/**
 * How far apart tufts grow at depth `d`, relative to their size: wider at
 * the crest than at the bottom edge.
 */
export function tuftSpacing(d: number): number {
  const near = Math.min(1, Math.max(0, d));
  return 1.25 + (0.95 - 1.25) * near;
}

const fields = new Map<number, readonly Tuft[]>();

/**
 * The grass at `density` (1: the GPU's full field; less spaces the tufts
 * out), back to front by base height. Deterministic, made once per density.
 */
export function grassField(density = 1): readonly Tuft[] {
  const known = fields.get(density);
  if (known) return known;
  const tufts: Tuft[] = [];
  const rise = DESIGN.height - crestAt(DESIGN.width / 2);
  let row = 0;
  for (let d = 0.01; d < 1.06; row++) {
    const size = tuftSize(d);
    // Closer together toward the viewer: there each tuft's own gaps show,
    // while far ones run together over ground that already reads as grass.
    const spread = (size * tuftSpacing(d)) / density;
    const step = spread * 0.34;
    const rowStep = (spread * 0.22) / rise;
    for (let i = 0, x = -step * seeded(`grass|${String(row)}`); ; i++) {
      x += step * (0.75 + 0.5 * seeded(`grass|${String(row)}|${String(i)}|x`));
      if (x > DESIGN.width + size / 2) break;
      const key = `grass|${String(row)}|${String(i)}`;
      // Rows follow the contour; each tuft strays almost a row either way
      // in depth, so they never read as rows.
      const dd = d + (seeded(`${key}|d`) - 0.5) * rowStep * 1.8;
      const crest = crestAt(Math.min(DESIGN.width, Math.max(0, x)));
      const y = crest + Math.max(0, dd) * (DESIGN.height - crest);
      const s = tuftSize(dd) * (0.75 + 0.5 * seeded(`${key}|s`));
      tufts.push({
        x,
        y,
        size: s,
        kind: pick(seeded(`${key}|k`)),
        flip: seeded(`${key}|f`) < 0.5,
        seed: seeded(`${key}|w`),
        stretch: 0.85 + 0.35 * seeded(`${key}|h`),
        stiff: 0.8 + 0.4 * seeded(`${key}|b`),
        delay: 0.15 * seeded(`${key}|l`),
        site: waveSite(x, y),
      });
    }
    d += rowStep;
  }
  tufts.sort((a, b) => a.y - b.y);
  fields.set(density, tufts);
  return tufts;
}

/**
 * The sheen of bent grass (TuftPose `lift`), the same on both tiers: a
 * fully bent tuft mixes this far toward this pale green, scaled by
 * daylight; one standing up between the waves darkens by `shade`.
 */
export const SHEEN = {
  color: [0.82, 0.94, 0.72],
  lift: 0.3,
  shade: 0.2,
} as const;

/** A tuft's pose in the wind. */
export interface TuftPose {
  /**
   * How far it bends downwind (windHeading), as the angle its tips turn
   * from upright, in radians; negative past upright, upwind.
   */
  bend: number;
  /**
   * Its sheen, -1..1: how far the passing wave bends it beyond its steady
   * bend. Bent grass shows its lighter sides; grass standing up between
   * the waves, darker. This is what makes the waves readable at a distance,
   * where a tuft's bend is a pixel or two.
   */
  lift: number;
}

/** The bend of grass in a steady wind of `speed` m/s: about 15° at 4 m/s, 60° in a hurricane. */
export function steadyBend(speed: number): number {
  return 1.25 * (1 - Math.exp(-Math.max(0, speed) / 18));
}

/** How far gusts of `gust` m/s (above the mean) bend grass beyond its steady bend, at most. */
export function gustBend(gust: number): number {
  return 1 - Math.exp(-Math.max(0, gust) / 5);
}

/** Bends beyond these, radians, flatten no further. */
export const BEND_MIN = -0.6;
export const BEND_MAX = 1.45;

/** What every tuft's pose shares in one frame's wind (tuftPose). */
export interface PoseFrame {
  wind: WindField;
  heading: { x: number; z: number };
  steady: number;
  gust: number;
  reach: number;
  /** Design pixels a second the waves travel. */
  speed: number;
  /** 0..1: how much the tufts flutter. */
  stir: number;
}

export function poseFrame(wind: WindField): PoseFrame {
  const gust = windGust(wind);
  return {
    wind,
    heading: windHeading(wind),
    steady: steadyBend(wind.speed),
    gust,
    reach: gustBend(gust),
    speed: waveSpeed(wind.speed),
    stir: Math.min(1, (wind.speed + gust) / 6),
  };
}

/**
 * A tuft's pose at `seconds` in `wind`. Neighbors move together: the bend
 * is the wind's steady push (steadyBend) plus the shared wave field
 * (wind-field.ts) at the tuft's base times the gusts' reach (gustBend),
 * so the waves roll across the hill; each tuft answers a little late
 * (`delay`) and by its own stiffness, with a trace of flutter. With
 * `seconds` null, at rest: the steady push alone. `frame`, when drawing
 * many tufts, is poseFrame(wind), made once.
 */
export function tuftPose(
  tuft: Tuft,
  seconds: number | null,
  wind: WindField,
  frame: PoseFrame = poseFrame(wind),
): TuftPose {
  if (seconds === null) return { bend: frame.steady, lift: 0 };
  // The wave as it was `delay` seconds ago: the pattern travels with the
  // wind, so that is the wave a little upwind.
  const late = seconds - tuft.delay;
  const travel = wind.travel - tuft.delay * frame.speed;
  const wave =
    gustEnvelope(late, frame.gust) *
    siteWave(tuft.site ?? waveSite(tuft.x, tuft.y), travel, frame.heading);
  const period = 1.2 + 0.9 * tuft.seed;
  const flutter = Math.sin(
    (2 * Math.PI * seconds) / period + tuft.seed * 2 * Math.PI,
  );
  const bend =
    frame.steady +
    tuft.stiff * frame.reach * wave +
    0.03 * frame.stir * flutter;
  return {
    bend: Math.max(BEND_MIN, Math.min(BEND_MAX, bend)),
    lift: wave * Math.min(1, frame.reach / 0.6),
  };
}

/**
 * How far the screen's up is tilted toward the ground's far side: the
 * viewer looks a little down on the hill, so a tip bent into the scene
 * rises a little on screen, and one bent toward the viewer drops.
 */
export const VIEW_TILT = 0.3;

/**
 * Where a tuft's stem is `v` up its length, bent by `bend` toward
 * `heading` (wind-field.ts windHeading) over its whole `height`: its
 * blades curve along a circular arc, tips most, so each keeps its length
 * rather than stretching as a shear would. Returns the offset from the
 * base on screen, in the units of `v` (x: right, up: up). A tuft is bent
 * row by row: every point of a row moves as its stem does, so upright
 * blades become arcs of the same length.
 */
export function tuftBend(
  v: number,
  height: number,
  bend: number,
  heading: { x: number; z: number },
): { x: number; up: number } {
  const phi = (bend * v) / Math.max(1e-6, height);
  // Along the ground and up, from the arc: v (1 - cos φ) / φ and v sin φ / φ.
  const small = Math.abs(phi) < 1e-4;
  const along = small ? (v * phi) / 2 : (v * (1 - Math.cos(phi))) / phi;
  const rise = small ? v : (v * Math.sin(phi)) / phi;
  return { x: heading.x * along, up: rise + VIEW_TILT * heading.z * along };
}

/** A tuft's height above its base, in its own size (the kind's rectangle, stretched). */
export function tuftHeight(tuft: Tuft): number {
  const base = TUFT_BASE[tuft.kind] ?? { x: 0.5, y: 1 };
  const top = TUFT_RECT[tuft.kind]?.[1] ?? 0;
  return (base.y - top) * tuft.stretch;
}
