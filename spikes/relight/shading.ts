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
  /** The same lights mirrored to the viewer's side, for the fill term. */
  sunFill: Vector3;
  moonFill: Vector3;
  ambient: Color;
  horizon: Color;
  haze: number;
  fill: number;
  translucency: number;
}

export const toLinear = (c: number) => Math.pow(c, 2.2);
export const toSrgb = (c: number) => Math.pow(Math.max(0, c), 1 / 2.2);

const linear = (c: Color, gain: number): Color => [
  toLinear(c[0]) * gain,
  toLinear(c[1]) * gain,
  toLinear(c[2]) * gain,
];

/**
 * The light stays physical: a Sun in the south, in front of a south-facing
 * viewer, backlights the scene. Two terms stand in for what a ray tracer
 * would give for free:
 *
 * - `translucency`: light passing through thin grass blades, petals, and
 *   leaves when they are lit from behind;
 * - `fill`: light bounced back toward the viewer from the rest of the field,
 *   modelled as the Sun and Moon mirrored to the viewer's side. It reaches
 *   only the hillside and the plants on it; a fill light near the viewer
 *   would not visibly brighten the distant mountains.
 */
export interface Adjustments {
  /** 0..1: power of the mirrored fill light, relative to the Sun and Moon. */
  fill: number;
  /** 0..1.5: scales each layer's translucency. */
  translucency: number;
}

export interface LayerLight {
  /** Depth haze, 0 for the foreground. */
  haze: number;
  /** How much light the layer's material lets through, 0..1. */
  translucency: number;
  /** Whether the viewer-side fill light reaches it. */
  fill: boolean;
}

export const LAYERS = {
  ridge: { haze: 0.5, translucency: 0, fill: false },
  hill: { haze: 0, translucency: 0.6, fill: true },
  sprites: { haze: 0, translucency: 0.9, fill: true },
} as const satisfies Record<string, LayerLight>;

const mirrored = (v: Vector3): Vector3 => ({ ...v, z: Math.abs(v.z) });

export function lightParams(
  state: LightingState,
  adjust: Adjustments,
): LightParams {
  return {
    sunDir: state.sun.direction,
    sun: linear(state.sun.color, state.sun.intensity * SUN_GAIN),
    moonDir: state.moon.direction,
    moon: linear(state.moon.color, state.moon.intensity * MOON_GAIN),
    sunFill: mirrored(state.sun.direction),
    moonFill: mirrored(state.moon.direction),
    ambient: linear(state.ambient, AMBIENT_GAIN),
    horizon: linear(state.sky.horizon, 1),
    haze: state.haze,
    fill: adjust.fill,
    translucency: adjust.translucency,
  };
}

function diffuse(n: Vector3, l: Vector3): number {
  const d = n.x * l.x + n.y * l.y + n.z * l.z;
  return Math.max(0, (d + WRAP) / (1 + WRAP));
}

/** Light arriving from behind the surface, passing through it. */
function through(n: Vector3, l: Vector3): number {
  return Math.max(0, -(n.x * l.x + n.y * l.y + n.z * l.z));
}

/**
 * Lit linear color for one texel. `albedo` is linear RGB; `n` is a unit
 * normal (x right, y up, z toward the viewer). Writes into `out`.
 */
export function shade(
  albedo: Color,
  n: Vector3,
  p: LightParams,
  layer: LayerLight,
  out: [number, number, number],
): void {
  const t = layer.translucency * p.translucency;
  const f = layer.fill ? p.fill : 0;
  const sun =
    diffuse(n, p.sunDir) + t * through(n, p.sunDir) + f * diffuse(n, p.sunFill);
  const moon =
    diffuse(n, p.moonDir) +
    t * through(n, p.moonDir) +
    f * diffuse(n, p.moonFill);
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
  const h = layer.haze * p.haze;
  for (let c = 0; c < 3; c++) {
    const light =
      (p.ambient[c] ?? 0) * hemi +
      (p.sun[c] ?? 0) * (sun + rim) +
      (p.moon[c] ?? 0) * moon;
    const lit = (albedo[c] ?? 0) * light;
    out[c] = lit + ((p.horizon[c] ?? 0) * 0.8 - lit) * h;
  }
}
