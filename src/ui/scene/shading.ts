/**
 * Shading shared by both tiers (ADR 0018). The software tier runs `shade`
 * on the CPU for every texel whenever the light changes (relight.ts); the
 * GPU tier's shader mirrors it line for line, so the two tiers can only
 * differ in *when* light is computed, not how. Pure: no DOM.
 */
import type {
  Color,
  LightingState,
  Vector3,
} from "../../environment/lighting.ts";

export const SUN_GAIN = 1.1;
export const MOON_GAIN = 2.6;
export const AMBIENT_GAIN = 0.55;
/** Wrap lighting: light reaches a little past the terminator, as in foliage. */
export const WRAP = 0.35;
export const RIM_GAIN = 0.3;
/**
 * Night vision. Below about 0.01 lux the eye sees with rods alone: no hue,
 * and a blue-green bias (rod sensitivity peaks near 507 nm), so moonlit
 * grass reads as the same grey-blue as the hazed ridges. `ROD` weights
 * linear sRGB by rod sensitivity; `NIGHT_TINT` is the slight blue cast a
 * moonlit scene is seen with, at about the same brightness.
 */
export const ROD: Color = [0.05, 0.53, 0.42];
export const NIGHT_TINT: Color = [0.68, 0.85, 1.23];

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
  /** 0 in daylight to 1 by nautical twilight: how far vision is rods only. */
  night: number;
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

/**
 * Locked by the maintainer (2026-09-27, ADR 0018 step 2): front fill at 50%
 * of the Sun and Moon, and translucency at 100% of each texel's map.
 */
export const LOCKED: Adjustments = { fill: 0.5, translucency: 1 };

export interface LayerLight {
  /** Depth haze, 0 for the foreground. */
  haze: number;
  /** How much light the layer's material lets through, 0..1. */
  translucency: number;
  /** Whether the viewer-side fill light reaches it. */
  fill: boolean;
  /**
   * 0..1: how far night vision takes its color. The plants go only halfway,
   * because their colors carry Git meaning.
   */
  night: number;
}

export const LAYERS = {
  ridge: { haze: 0.5, translucency: 0, fill: false, night: 1 },
  hill: { haze: 0, translucency: 0.6, fill: true, night: 1 },
  sprites: { haze: 0, translucency: 0.9, fill: true, night: 0.5 },
  // Lit as the sprites, but grass goes as dark at night as the ground
  // (the sprites keep some light, to stay readable).
  grass: { haze: 0, translucency: 0.9, fill: true, night: 1 },
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
    night: 1 - smoothstep(-9, -1, state.sun.altitude),
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
 * normal (x right, y up, z toward the viewer). `map`, when given, is the
 * texel's own translucency (0..1) from a translucency map, replacing the
 * layer's constant. Writes into `out`.
 */
export function shade(
  albedo: Color,
  n: Vector3,
  p: LightParams,
  layer: LayerLight,
  out: [number, number, number],
  map?: number,
): void {
  const t = (map ?? layer.translucency) * p.translucency;
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
  const lit: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const light =
      (p.ambient[c] ?? 0) * hemi +
      (p.sun[c] ?? 0) * (sun + rim) +
      (p.moon[c] ?? 0) * moon;
    lit[c] = (albedo[c] ?? 0) * light;
  }
  // Night vision, before haze: the haze is the sky's own color.
  const v = p.night * layer.night;
  const rod = lit[0] * ROD[0] + lit[1] * ROD[1] + lit[2] * ROD[2];
  for (let c = 0; c < 3; c++) {
    const seen =
      (lit[c] ?? 0) + (rod * (NIGHT_TINT[c] ?? 0) - (lit[c] ?? 0)) * v;
    out[c] = seen + ((p.horizon[c] ?? 0) * 0.8 - seen) * h;
  }
}
