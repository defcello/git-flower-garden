/*
 * The hill's grass (ADR 0021): Codex-painted tufts planted over the ground
 * layer, each bending with the wind about where it grows. Pure, so the
 * planting and any moment of the wind are testable; the tiers draw it
 * (GardenCanvas.tsx, plants-gpu.ts), interleaved with the plants by depth.
 *
 * Tufts are planted in rows that follow the hill's contour, from the crest
 * (small, far) to the bottom edge (large, near), each spaced in proportion
 * to its size, so the hill reads as grass at every depth. A tuft leans
 * downwind as the wind blows, by a shear about its base: further as a gust
 * patch of the shared wind field (wind-field.ts) passes, springing back in
 * the lulls between, with a little flutter of its own.
 */
import { seeded } from "../botanical.ts";
import { CREST, CREST_STEP } from "./crest.ts";
import { DESIGN } from "./view.ts";
import { windDirection, windWave, type WindField } from "./wind-field.ts";

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
}

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
    // Far rows thin out: there the ground layer already reads as grass.
    const sparse = 1 + 0.3 * (1 - Math.min(1, d));
    // Near tufts are large enough to close the gaps a little further apart.
    const near = 1 + 0.3 * Math.min(1, d);
    const step = (size * 0.34 * sparse * near) / density;
    const rowStep = (size * 0.22 * sparse * near) / density / rise;
    for (let i = 0, x = -step * seeded(`grass|${String(row)}`); ; i++) {
      x += step * (0.75 + 0.5 * seeded(`grass|${String(row)}|${String(i)}|x`));
      if (x > DESIGN.width + size / 2) break;
      const key = `grass|${String(row)}|${String(i)}`;
      // Rows follow the contour; each tuft strays almost a row either way
      // in depth, so they never read as rows.
      const dd = d + (seeded(`${key}|d`) - 0.5) * rowStep * 1.8;
      const crest = crestAt(Math.min(DESIGN.width, Math.max(0, x)));
      const y = crest + Math.max(0, dd) * (DESIGN.height - crest);
      const s = tuftSize(dd) * (0.8 + 0.4 * seeded(`${key}|s`));
      tufts.push({
        x,
        y,
        size: s,
        kind: pick(seeded(`${key}|k`)),
        flip: seeded(`${key}|f`) < 0.5,
        seed: seeded(`${key}|w`),
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
   * Its lean, as a shear: the tip moves this many tuft heights downwind
   * (+ is right). Within ±0.9.
   */
  lean: number;
  /**
   * Its sheen, -1..1: how far the passing wave bends it beyond its steady
   * lean. Bent grass shows its lighter sides; grass standing up between
   * the waves, darker. This is what makes the waves readable at a distance,
   * where a tuft's lean is a pixel or two.
   */
  lift: number;
}

/**
 * A tuft's pose at `seconds` in a wind of `strength` (sway.ts
 * `windStrength`, up to `maxStrength`). Neighbors move together: the lean
 * is the wind's steady push plus the shared wave field (wind-field.ts)
 * at the tuft's base, rolling across the hill as gusts pass, with only a
 * trace of each tuft's own flutter. With `seconds` null, at rest: the
 * steady push alone.
 */
export function tuftPose(
  tuft: Tuft,
  seconds: number | null,
  wind: WindField,
  strength: number,
  maxStrength: number,
): TuftPose {
  const s = Math.min(strength, maxStrength) / maxStrength;
  const direction = windDirection(wind.windX);
  const steady = direction * s * 0.28;
  if (seconds === null) return { lean: steady, lift: 0 };
  const wave = windWave(tuft.x, tuft.y, seconds, wind);
  const period = 1.2 + 0.9 * tuft.seed;
  const flutter = Math.sin(
    (2 * Math.PI * seconds) / period + tuft.seed * 2 * Math.PI,
  );
  const lean = steady + direction * s * 0.45 * wave + 0.012 * flutter;
  return {
    lean: Math.max(-0.9, Math.min(0.9, lean)),
    lift: wave * Math.min(1, 0.35 + s),
  };
}

/** How much a leaning tuft shortens, so its blades keep their length. */
export function tuftSquash(lean: number): number {
  return 1 / Math.sqrt(1 + lean * lean);
}
