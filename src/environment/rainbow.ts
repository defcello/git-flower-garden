/**
 * The rainbow from optics (ADR 0018 step 5): sunlight refracted, reflected
 * once (primary) or twice (secondary) inside spherical drops of water, and
 * refracted out again. Pure; computed once per page.
 *
 * For each wavelength, rays enter a drop at every impact parameter; Snell's
 * law and the Fresnel equations give where each leaves and how much of it
 * does (Descartes' construction). Collected by angle from the antisolar
 * point, this gives the primary bow at about 42° with red outermost, the
 * fainter secondary at about 51° with the colours reversed, Alexander's
 * dark band between them, and the brighter sky inside the primary. The
 * result is blurred by the width of the Sun's disc and by drop size, and
 * turned into colour with the CIE 1931 colour-matching functions.
 *
 * Where the bow appears is then pure geometry: a point of the sky shows
 * the profile at its angle from the antisolar point (opposite the Sun).
 */
import type { Color } from "./lighting.ts";

const DEG = Math.PI / 180;

/**
 * Refractive index of water at 20 °C (Daimon and Masumura, 2007), by
 * wavelength in nanometres; linear between entries.
 */
const WATER: readonly (readonly [number, number])[] = [
  [380, 1.3459],
  [404.656, 1.34349],
  [435.835, 1.3404],
  [486.13, 1.33713],
  [546.07, 1.33447],
  [589.29, 1.33299],
  [656.27, 1.33114],
  [706.52, 1.33008],
  [760, 1.3292],
];

export function waterIndex(nm: number): number {
  const first = WATER[0] ?? [380, 1.3459];
  if (nm <= first[0]) return first[1];
  for (let i = 1; i < WATER.length; i++) {
    const [x1, y1] = WATER[i] ?? first;
    const [x0, y0] = WATER[i - 1] ?? first;
    if (nm <= x1) return y0 + ((y1 - y0) * (nm - x0)) / (x1 - x0);
  }
  return (WATER[WATER.length - 1] ?? first)[1];
}

/**
 * Fresnel reflectance from air into water at incidence `i`, for light
 * polarised perpendicular (s) and parallel (p) to the plane of incidence.
 * Inside the drop each surface meets the ray at the refracted angle, where
 * reciprocity gives the same two values.
 */
function reflectance(i: number, n: number): { s: number; p: number } {
  const r = Math.asin(Math.sin(i) / n);
  const ci = Math.cos(i);
  const cr = Math.cos(r);
  const s = (ci - n * cr) / (ci + n * cr);
  const p = (cr - n * ci) / (cr + n * ci);
  return { s: s * s, p: p * p };
}

/**
 * Angle from the antisolar point (degrees) of a ray with incidence `i`
 * after `k` internal reflections: 4r − 2i for the primary, 180° + 2i − 6r
 * for the secondary (seen on the other side of its minimum deviation).
 */
export function exitAngle(i: number, n: number, k: 1 | 2): number {
  const r = Math.asin(Math.sin(i) / n);
  return k === 1 ? (4 * r - 2 * i) / DEG : 180 + (2 * i - 6 * r) / DEG;
}

/** The bow's angle for index `n`: the extreme of `exitAngle` (degrees). */
export function bowAngle(n: number, k: 1 | 2): number {
  // Stationary deviation: cos² i = (n² − 1) / ((k + 1)² − 1).
  const i = Math.acos(Math.sqrt((n * n - 1) / ((k + 1) * (k + 1) - 1)));
  return exitAngle(i, n, k);
}

/** A piecewise Gaussian (Wyman, Sloan, and Shirley, 2013). */
function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/** CIE 1931 2° colour matching, analytic fit, to linear sRGB. */
export function wavelengthRgb(nm: number): Color {
  const x =
    1.056 * lobe(nm, 599.8, 37.9, 31.0) +
    0.362 * lobe(nm, 442.0, 16.0, 26.7) -
    0.065 * lobe(nm, 501.1, 20.4, 26.2);
  const y =
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1);
  const z =
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8);
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
}

/** Profile resolution and extent, degrees from the antisolar point. */
export const PROFILE_STEP = 0.05;
export const PROFILE_MAX = 90;
const BINS = Math.round(PROFILE_MAX / PROFILE_STEP);
/** Angular radius of the Sun's disc, degrees. */
const SUN_RADIUS = 0.265;
/** Further spread from diffraction by drops about 1 mm across, degrees. */
const DROP_SIGMA = 0.2;

let cached: Float32Array | null = null;

/**
 * Light sent back by rain at each angle from the antisolar point, linear
 * RGB per `PROFILE_STEP`, for white sunlight; scaled so the primary bow's
 * brightest luminance is 1. Computed once.
 */
export function rainbowProfile(): Float32Array {
  if (cached !== null) return cached;
  const raw = new Float64Array(BINS * 3);
  // White balance: equal-energy light over the band comes out white.
  const white: [number, number, number] = [0, 0, 0];
  const RAYS = 4000;
  for (let nm = 380; nm <= 760; nm += 5) {
    const rgb = wavelengthRgb(nm);
    white[0] += rgb[0];
    white[1] += rgb[1];
    white[2] += rgb[2];
    const n = waterIndex(nm);
    for (let j = 0; j < RAYS; j++) {
      // Rays fall evenly on the drop's disc: weight by the annulus, b db.
      const b = (j + 0.5) / RAYS;
      const i = Math.asin(b);
      const { s, p } = reflectance(i, n);
      for (const k of [1, 2] as const) {
        const theta = exitAngle(i, n, k);
        if (theta < 0 || theta >= PROFILE_MAX) continue;
        // In, k reflections inside, out: each polarisation on its own,
        // since sunlight is unpolarised and the rainbow strongly is not.
        const energy =
          (b *
            ((1 - s) * (1 - s) * Math.pow(s, k) +
              (1 - p) * (1 - p) * Math.pow(p, k))) /
          2;
        const bin = Math.floor(theta / PROFILE_STEP);
        raw[bin * 3] = (raw[bin * 3] ?? 0) + energy * rgb[0];
        raw[bin * 3 + 1] = (raw[bin * 3 + 1] ?? 0) + energy * rgb[1];
        raw[bin * 3 + 2] = (raw[bin * 3 + 2] ?? 0) + energy * rgb[2];
      }
    }
  }
  // Per unit solid angle: a ring at θ spans sin θ.
  for (let bin = 0; bin < BINS; bin++) {
    const solid = Math.sin((bin + 0.5) * PROFILE_STEP * DEG);
    for (let c = 0; c < 3; c++)
      raw[bin * 3 + c] = (raw[bin * 3 + c] ?? 0) / solid / (white[c] ?? 1);
  }
  // Blur: the Sun's disc (each point of it makes its own bow) and drops.
  const reach = Math.ceil((SUN_RADIUS + 3 * DROP_SIGMA) / PROFILE_STEP);
  const kernel: number[] = [];
  for (let d = -reach; d <= reach; d++) {
    const x = d * PROFILE_STEP;
    let w = 0;
    // The disc's width at each offset, smoothed by the drops' spread.
    for (let s = -SUN_RADIUS; s <= SUN_RADIUS; s += PROFILE_STEP / 2) {
      const chord = Math.sqrt(Math.max(0, 1 - (s / SUN_RADIUS) ** 2));
      w += chord * Math.exp(-0.5 * ((x - s) / DROP_SIGMA) ** 2);
    }
    kernel.push(w);
  }
  const total = kernel.reduce((a, b) => a + b, 0);
  const profile = new Float32Array(BINS * 3);
  for (let bin = 0; bin < BINS; bin++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      kernel.forEach((w, j) => {
        const from = Math.min(BINS - 1, Math.max(0, bin + j - reach));
        sum += w * (raw[from * 3 + c] ?? 0);
      });
      profile[bin * 3 + c] = sum / total;
    }
  // Scale: the primary's brightest luminance is 1.
  let peak = 0;
  for (let bin = 0; bin < Math.round(45 / PROFILE_STEP); bin++) {
    const l =
      0.2126 * (profile[bin * 3] ?? 0) +
      0.7152 * (profile[bin * 3 + 1] ?? 0) +
      0.0722 * (profile[bin * 3 + 2] ?? 0);
    peak = Math.max(peak, l);
  }
  for (let j = 0; j < profile.length; j++)
    profile[j] = (profile[j] ?? 0) / peak;
  cached = profile;
  return profile;
}

/** The profile at `theta` degrees from the antisolar point (linear RGB). */
export function rainbowAt(theta: number, out: number[] = [0, 0, 0]): number[] {
  const profile = rainbowProfile();
  const x = theta / PROFILE_STEP - 0.5;
  if (x < 0 || x >= BINS - 1) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const bin = Math.floor(x);
  const f = x - bin;
  for (let c = 0; c < 3; c++)
    out[c] =
      (profile[bin * 3 + c] ?? 0) * (1 - f) +
      (profile[(bin + 1) * 3 + c] ?? 0) * f;
  return out;
}
