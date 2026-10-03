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

/** Share of each kind: short dense, tall, broad, seeding. */
const KIND_WEIGHTS = [0.42, 0.2, 0.13, 0.25];

/** Cell size of a tuft at the crest and at the bottom edge, design pixels. */
const SIZE_FAR = 12;
const SIZE_NEAR = 115;

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
    const sparse = 1 + 0.6 * (1 - Math.min(1, d));
    const step = (size * 0.5 * sparse) / density;
    const rowStep = (size * 0.32 * sparse) / density / rise;
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
 * How far a tuft leans, as a shear (its tip moves this many tuft heights
 * downwind; + is right), in a wind of `strength` (sway.ts `windStrength`,
 * up to MAX_WIND_STRENGTH). With `seconds` null, its lean at rest: the
 * wind's steady push, without gusts or flutter. Within ±0.9.
 */
export function tuftLean(
  tuft: Tuft,
  seconds: number | null,
  wind: WindField,
  strength: number,
  maxStrength: number,
): number {
  const s = Math.min(strength, maxStrength) / maxStrength;
  const direction = windDirection(wind.windX);
  const steady = direction * s * 0.3;
  if (seconds === null) return steady;
  const gust = windWave(tuft.x, tuft.y, seconds, wind);
  const period = 1.2 + 0.9 * tuft.seed;
  const flutter = Math.sin(
    (2 * Math.PI * seconds) / period + tuft.seed * 2 * Math.PI,
  );
  const lean = steady + direction * s * 0.4 * gust + 0.05 * (0.4 + s) * flutter;
  return Math.max(-0.9, Math.min(0.9, lean));
}

/** How much a leaning tuft shortens, so its blades keep their length. */
export function tuftSquash(lean: number): number {
  return 1 / Math.sqrt(1 + lean * lean);
}
