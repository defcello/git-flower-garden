/**
 * Shading shared by both tiers (ADR 0018 step 2 spike). The WebGL2 shader in
 * gpu.ts mirrors `shade` line for line; the software tier bakes its keyframes
 * with `shade` on the CPU, so the two can only differ in *when* light is
 * computed, not how.
 */
import type {
  Color,
  LightingState,
  Vector3,
} from "../../src/environment/lighting.ts";

export const SUN_GAIN = 1.1;
export const MOON_GAIN = 2.6;
export const AMBIENT_GAIN = 0.55;
/** Wrap lighting: light reaches a little past the terminator, as in foliage. */
export const WRAP = 0.35;
export const RIM_GAIN = 0.3;

export interface LightParams {
  sunDir: Vector3;
  /** Linear RGB, already scaled by intensity and gain. */
  sun: Color;
  moonDir: Vector3;
  moon: Color;
  ambient: Color;
  horizon: Color;
  haze: number;
}

export const toLinear = (c: number) => Math.pow(c, 2.2);
export const toSrgb = (c: number) => Math.pow(Math.max(0, c), 1 / 2.2);

const linear = (c: Color, gain: number): Color => [
  toLinear(c[0]) * gain,
  toLinear(c[1]) * gain,
  toLinear(c[2]) * gain,
];

/**
 * Where the light comes from. "physical": the real direction, so a Sun in
 * the south (in front of a south-facing viewer) backlights the scene.
 * "viewer": the same direction mirrored to the viewer's side, as on a stage.
 */
export type LightSide = "physical" | "viewer";

const side = (v: Vector3, which: LightSide): Vector3 =>
  which === "viewer" ? { ...v, z: Math.abs(v.z) } : v;

export function lightParams(
  state: LightingState,
  which: LightSide = "physical",
): LightParams {
  return {
    sunDir: side(state.sun.direction, which),
    sun: linear(state.sun.color, state.sun.intensity * SUN_GAIN),
    moonDir: side(state.moon.direction, which),
    moon: linear(state.moon.color, state.moon.intensity * MOON_GAIN),
    ambient: linear(state.ambient, AMBIENT_GAIN),
    horizon: linear(state.sky.horizon, 1),
    haze: state.haze,
  };
}

function diffuse(n: Vector3, l: Vector3): number {
  const d = n.x * l.x + n.y * l.y + n.z * l.z;
  return Math.max(0, (d + WRAP) / (1 + WRAP));
}

/**
 * Lit linear color for one texel. `albedo` is linear RGB; `n` is a unit
 * normal (x right, y up, z toward the viewer); `haze` is the layer's depth
 * haze, 0 for the foreground. Writes into `out`.
 */
export function shade(
  albedo: Color,
  n: Vector3,
  p: LightParams,
  haze: number,
  out: [number, number, number],
): void {
  const sun = diffuse(n, p.sunDir);
  const moon = diffuse(n, p.moonDir);
  // Sky light from above, a little less on faces turned down.
  const hemi = 0.75 + 0.25 * n.y;
  // Backlight catches silhouettes when the light is behind the scene.
  const edge = 1 - Math.max(0, n.z);
  const rim =
    RIM_GAIN *
    edge *
    edge *
    edge *
    Math.max(0, -p.sunDir.z) *
    Math.max(0, p.sunDir.y + 0.2);
  const h = haze * p.haze;
  for (let c = 0; c < 3; c++) {
    const light =
      (p.ambient[c] ?? 0) * hemi +
      (p.sun[c] ?? 0) * (sun + rim) +
      (p.moon[c] ?? 0) * moon;
    const lit = (albedo[c] ?? 0) * light;
    out[c] = lit + ((p.horizon[c] ?? 0) * 0.8 - lit) * h;
  }
}
