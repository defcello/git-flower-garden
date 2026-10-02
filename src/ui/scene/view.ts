/**
 * What the scene draws, in canvas pixels: the cover transform from the
 * 1920×1080 design space (ADR 0018 "Resolution"), the sky bodies, and the
 * star field. Every tier draws from these; only the shading of art differs.
 * Pure: no DOM.
 */
import {
  lightingState,
  type LightingState,
} from "../../environment/lighting.ts";
import { previewSnapshot } from "../../environment/overrides.ts";
import {
  lightParams,
  LOCKED,
  shade,
  type LayerLight,
  type LightParams,
} from "./shading.ts";

export const DESIGN = { width: 1920, height: 1080 };
/** Where altitude 0 sits, as a fraction of the design height: behind the far ridges. */
export const HORIZON = 0.5;

export interface Transform {
  width: number;
  height: number;
  scale: number;
  ox: number;
  oy: number;
}

/**
 * Cover the canvas, anchored at the bottom center: wider screens crop sky,
 * taller ones crop the sides. The hillside slots (hillside.ts) assume this.
 */
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

export interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

/** A seeded star field above the horizon, in design pixels: stars never jump. */
export const STARS: readonly Star[] = (() => {
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

/**
 * A sky body in design pixels: the panorama (east left, west right) across
 * the width, physical altitude from the horizon to the top edge at 90°.
 */
export function skyPoint(body: { u: number; altitude: number }) {
  return {
    x: DESIGN.width * (0.04 + 0.92 * body.u),
    y: DESIGN.height * HORIZON * (1 - Math.max(-10, body.altitude) / 90),
  };
}

/** Design pixels per degree of altitude: the panorama's physical scale. */
export const PIXELS_PER_DEGREE = (DESIGN.height * HORIZON) / 90;

/**
 * Where a point of the sky is drawn, in design pixels, without `skyPoint`'s
 * floor below the horizon: for what is centred below it, like a rainbow.
 */
export function skyPlace(body: { u: number; altitude: number }) {
  return {
    x: DESIGN.width * (0.04 + 0.92 * body.u),
    y: DESIGN.height * HORIZON * (1 - body.altitude / 90),
  };
}

/** The primary rainbow's angle from the antisolar point, degrees (rainbow.ts). */
export const RAINBOW_RADIUS = 42;

/**
 * Where rain meets the ground behind the hill, in design pixels: the
 * lowest point of the hill's crest in the art (measured: from 0.622 of the
 * height in the middle to 0.759 at the edges), so the hill hides it from
 * edge to edge. A rainbow in rain stands on the ground; below this line it
 * is never drawn.
 */
export const RAINBOW_GROUND = Math.round(0.76 * DESIGN.height);

/**
 * Design pixels per degree of a rainbow's own angles. The landscape is not
 * at its true depth (the hill fills what would be tens of degrees below
 * the horizon), so a rainbow drawn at the sky's scale looked small and
 * showed the lower half of its circle over the ridges. Instead the bow
 * stands on the ground line, its centre (the antisolar point) the Sun's
 * altitude below it, so its lower half is always behind the hill
 * (maintainer's rule, 2026-10-01); and this scale puts its top at the true
 * height, 42° less the Sun's altitude on the sky's scale, at every Sun
 * altitude. About 2.1 times the sky's scale.
 */
export const RAINBOW_SCALE =
  (RAINBOW_GROUND - DESIGN.height * HORIZON) / RAINBOW_RADIUS +
  PIXELS_PER_DEGREE;

/** The centre of the rainbow's circles, in design pixels (see RAINBOW_SCALE). */
export function rainbowCentre(antisolar: { u: number; altitude: number }) {
  return {
    x: skyPlace(antisolar).x,
    y: RAINBOW_GROUND - antisolar.altitude * PIXELS_PER_DEGREE,
  };
}

/**
 * Degrees from the rainbow's centre to a design-space point, as a viewer
 * facing the bow sees them: the same scale every way, so its circles are
 * round although the panorama spreads azimuth wider than altitude.
 */
export function rainbowAngle(
  x: number,
  y: number,
  centre: { x: number; y: number },
): number {
  return Math.hypot(x - centre.x, y - centre.y) / RAINBOW_SCALE;
}

export interface SkyBodies {
  horizonY: number;
  sun: { x: number; y: number; r: number; glow: number; alpha: number } | null;
  moon: {
    x: number;
    y: number;
    r: number;
    alpha: number;
    /** Direction to the Sun on the Moon's disc (x right, y up, z out). */
    s: [number, number, number];
  } | null;
  stars: Star[];
}

export function skyBodies(t: Transform, state: LightingState): SkyBodies {
  const sunP = toCanvas(t, skyPoint(state.sun).x, skyPoint(state.sun).y);
  const moonP = toCanvas(t, skyPoint(state.moon).x, skyPoint(state.moon).y);
  const e = (state.moon.phaseDegrees * Math.PI) / 180;
  const limb = (state.moon.limbAngle * Math.PI) / 180;
  const side = Math.abs(Math.sin(e));
  return {
    horizonY: t.oy + DESIGN.height * HORIZON * t.scale,
    sun:
      state.sun.altitude > -1
        ? {
            ...sunP,
            r: 22 * t.scale,
            glow: 150 * t.scale,
            alpha: Math.min(1, (state.sun.altitude + 1) / 2),
          }
        : null,
    moon:
      state.moon.altitude > -1
        ? {
            ...moonP,
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
  s: readonly [number, number, number],
): number {
  const z = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const d = dx * s[0] + dy * s[1] + z * s[2];
  const t = Math.min(1, Math.max(0, (d + 0.04) / 0.08));
  // Earthshine keeps the dark side faintly visible.
  return 0.07 + 0.93 * t * t * (3 - 2 * t);
}

export const MOON_COLOR: readonly [number, number, number] = [0.94, 0.93, 0.87];

/** The locked lighting for a state (ADR 0018): what the art is relit with. */
export function sceneLight(state: LightingState): LightParams {
  return lightParams(state, LOCKED);
}

/**
 * A key that changes only when relighting would visibly change the art:
 * directions to about 0.3° (the Sun moves 0.25° a minute), colors and
 * intensities to 0.5%. Equal keys skip the relight.
 */
export function lightKey(p: LightParams): string {
  const round = (v: number) => Math.round(v * 200);
  // A dark body's direction lights nothing, so it must not force a relight.
  const vector = (
    v: { x: number; y: number; z: number },
    color: readonly number[],
  ) => (Math.max(...color) < 0.0025 ? [0, 0, 0] : [v.x, v.y, v.z]);
  return [
    ...vector(p.sunDir, p.sun),
    ...p.sun,
    ...vector(p.moonDir, p.moon),
    ...p.moon,
    ...p.ambient,
    ...p.horizon,
    p.haze,
    p.fill,
    p.translucency,
  ]
    .map((v) => String(round(v)))
    .join(",");
}

/**
 * Stems are thin, opaque-ish, and face the viewer, tilted a little up. They
 * keep their color at night: stems, knots, and missing-history boundaries
 * are Git marks, and the GPU tier lights them per channel, which a shift
 * toward night vision cannot be.
 */
const STEM_LIGHT: LayerLight = {
  haze: 0,
  translucency: 0.3,
  fill: true,
  night: 0,
};
const STEM_NORMAL = { x: 0, y: 0.35, z: Math.sqrt(1 - 0.35 * 0.35) };

/**
 * A flat `#rrggbb` color as lit by `p`, the way the art is: so procedural
 * stems, knots, and their halos darken with the sprites at night instead of
 * glowing over a moonlit hill.
 */
export function litColor(hex: string, p: LightParams): string {
  const channel = (i: number) =>
    Math.pow(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255, 2.2);
  const out: [number, number, number] = [0, 0, 0];
  shade([channel(0), channel(1), channel(2)], STEM_NORMAL, p, STEM_LIGHT, out);
  const srgb = out.map((v) =>
    Math.round(Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255),
  );
  return `rgb(${srgb.map(String).join(" ")})`;
}

/**
 * The light on stems and knots, per linear channel: what `litColor`
 * multiplies an unlit color by (stems face one way, and have no haze). The
 * GPU tier lights its unlit stem textures with it.
 */
export function stemLight(p: LightParams): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  shade([1, 1, 1], STEM_NORMAL, p, STEM_LIGHT, out);
  return out;
}

/**
 * The light when no location is configured: the noon preview, so the
 * garden is still lit by a real Sun, just not the viewer's own.
 */
export const DAYTIME: LightingState = lightingState(previewSnapshot("noon"));

export interface PlantShadow {
  /**
   * The shadow on the ground, per pixel of height above the plant's base:
   * how far it runs sideways (`shear`, + right) and down the screen
   * (`squash`, + toward the viewer, − up the slope, foreshortened).
   */
  shear: number;
  squash: number;
  /** The silhouette's blur, in the plant's own pixels, before it is cast. */
  blur: number;
  alpha: number;
}

/** The shadow's blur, in the plant's own pixels: the same at any light. */
export const PLANT_SHADOW_BLUR = 2.5;

/** The shadow's color, without its alpha. */
export const PLANT_SHADOW_RGB = "21 45 23";

/** How much shorter the hillside's depth looks than its width. */
const GROUND_FORESHORTENING = 0.3;

/** The longest shadow, in plant heights, so a low Sun's stays on the hill. */
const LONGEST_SHADOW = 3;

/** A shadow at least this deep, so one cast straight sideways still shows. */
const THINNEST_SHADOW = 0.04;

/**
 * The plants' shadows: each plant's silhouette laid on the ground from its
 * base, away from the Sun, longer as it sinks, and gone once it is down.
 * A shadow never stands up beside the plant: it lies on the hill.
 */
export function plantShadow(state: LightingState): PlantShadow | null {
  const s = state.shadow;
  if (s === null) return null;
  const length = Math.min(s.length, LONGEST_SHADOW);
  const depth = s.z * length * GROUND_FORESHORTENING;
  return {
    shear: s.x * length,
    squash:
      Math.abs(depth) < THINNEST_SHADOW
        ? depth < 0
          ? -THINNEST_SHADOW
          : THINNEST_SHADOW
        : depth,
    blur: PLANT_SHADOW_BLUR,
    alpha: 0.22 * Math.min(1, state.sun.intensity * 1.5),
  };
}

/**
 * The 2D transform (as `setTransform(a, b, c, d, e, f)`) that lays a
 * plant's upright silhouette on the ground from its base at canvas height
 * `baseY`: a point h pixels above the base lands `shear` h to the side and
 * `squash` h below the base.
 */
export function castOnGround(
  shadow: PlantShadow,
  baseY: number,
): [number, number, number, number, number, number] {
  const { shear, squash } = shadow;
  return [1, 0, -shear, -squash, shear * baseY, (1 + squash) * baseY];
}

/** The plant markers' CSS drop shadow: a short offset toward the shadow. */
const MARKER_OFFSET = 4;

/**
 * CSS custom properties for the drop shadow of what CSS draws (styles.css
 * .plant, .plant-marker): a short offset toward the plants' shadow, which
 * reads as contact with the ground, not as a second plant in the air.
 */
export function plantShadowStyle(state: LightingState): Record<string, string> {
  const shadow = plantShadow(state);
  if (shadow === null)
    return { "--shadow-x": "0px", "--shadow-y": "0px", "--shadow-alpha": "0" };
  const reach = Math.hypot(shadow.shear, shadow.squash);
  const x = reach > 0 ? (shadow.shear / reach) * MARKER_OFFSET : 0;
  const y = reach > 0 ? (shadow.squash / reach) * MARKER_OFFSET : 0;
  return {
    "--shadow-x": `${x.toFixed(1)}px`,
    // Always a little below: the ground is under the plant.
    "--shadow-y": `${Math.max(2, y).toFixed(1)}px`,
    "--shadow-alpha": shadow.alpha.toFixed(3),
  };
}
