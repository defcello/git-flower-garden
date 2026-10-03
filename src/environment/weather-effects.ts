/**
 * What the weather does to the scene (ADR 0018 `WeatherState`, ADR 0020):
 * pure, so both drawing tiers show the same weather and every case is
 * testable.
 *
 * - The light: cloud dims the Sun and Moon and their shadows, greys the
 *   sky, and hides the stars; fog and precipitation thicken the haze. The
 *   result is an ordinary `LightingState`, so both tiers relight the art
 *   for it with no further changes.
 * - Clouds: a seeded field of soft puffs in the sky, drifting with the wind
 *   as the minutes pass (never per frame), behind the mountains.
 * - Precipitation: rain streaks or snowflakes over the hillside, as many as
 *   the intensity asks for within the tier's cap, slanted by the wind.
 * - Fog: a pale band over the hill.
 * - A rainbow wherever sunlight falls on rain, placed, sized, and coloured
 *   by the optics of water drops (rainbow.ts); inferred from the forecast,
 *   never reported as observed.
 */
import type { Color, LightingState } from "./lighting.ts";
import type {
  Intensity,
  PrecipitationType,
  WeatherConditions,
} from "./weather.ts";

/** The weather in the scene's terms. `NO_WEATHER` is the neutral sky. */
export interface WeatherEffects {
  /** 0..1 of the sky covered. */
  cloudCover: number;
  /** 0..1: how dark the clouds' undersides are (rain and thunder darken). */
  cloudDarkness: number;
  fog: number;
  precipitation: {
    type: Exclude<PrecipitationType, "none">;
    /** 0..1 of the tier's particle cap. */
    density: number;
    showers: boolean;
  } | null;
  /** Screen-space wind: + blows to the right (westward), m/s. */
  windX: number;
  /** + blows away from the viewer, into the scene (southward), m/s. */
  windZ: number;
  windSpeed: number;
  /** How much faster than `windSpeed` the gusts blow, m/s. */
  windGust: number;
  thunder: boolean;
}

export const NO_WEATHER: WeatherEffects = {
  cloudCover: 0,
  cloudDarkness: 0,
  fog: 0,
  precipitation: null,
  windX: 0,
  windZ: 0,
  windSpeed: 0,
  windGust: 0,
  thunder: false,
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const DENSITY: Record<Intensity, number> = {
  none: 0,
  light: 0.3,
  moderate: 0.6,
  heavy: 1,
};

/**
 * The scene's weather from normalized conditions. The viewer faces south:
 * east is on the left of the panorama, so wind blowing toward the west
 * moves things right, and wind from the north blows into the scene. The
 * forecast gives no gusts: they are taken as half again the mean wind.
 */
export function weatherEffects(c: WeatherConditions | null): WeatherEffects {
  if (c === null) return NO_WEATHER;
  const p = c.precipitation;
  const type = p.type === "none" || p.intensity === "none" ? null : p.type;
  const falling = type !== null;
  // Precipitation needs cloud overhead, whatever the model's cover says.
  const cover = clamp(
    Math.max(c.cloudCover, falling ? (p.showers ? 0.6 : 0.85) : 0),
    0,
    1,
  );
  const toward = ((c.wind.fromDegrees + 180) * Math.PI) / 180;
  return {
    cloudCover: cover,
    cloudDarkness: clamp(
      (falling ? 0.35 + 0.35 * DENSITY[p.intensity] : 0.15 * cover) +
        (c.thunder ? 0.25 : 0),
      0,
      1,
    ),
    fog: c.fog ? 1 : 0,
    precipitation:
      type === null
        ? null
        : { type, density: DENSITY[p.intensity], showers: p.showers },
    windX: -Math.sin(toward) * c.wind.speedMetersPerSecond,
    windZ: -Math.cos(toward) * c.wind.speedMetersPerSecond,
    windSpeed: c.wind.speedMetersPerSecond,
    windGust: 0.5 * c.wind.speedMetersPerSecond,
    thunder: c.thunder,
  };
}

const mix = (a: Color, b: Color, t: number): Color => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const luma = (c: Color) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const grey = (c: Color, scale = 1): Color => {
  const l = luma(c) * scale;
  return [l, l, l];
};

/**
 * The light under the weather. Overcast leaves about a fifth of the direct
 * Sun, as diffuse light from a grey sky; the ambient light stays, so a
 * cloudy noon is dull but not dark. Shadows fade with the direct light.
 */
export function weatherLighting(
  state: LightingState,
  w: WeatherEffects,
): LightingState {
  if (w === NO_WEATHER) return state;
  const cover = w.cloudCover;
  const direct = directLight(w);
  const overcast = clamp(cover * 0.85 + w.fog * 0.3, 0, 1);
  const gloom = 1 - 0.35 * w.cloudDarkness * cover;
  return {
    ...state,
    sun: { ...state.sun, intensity: state.sun.intensity * direct },
    moon: { ...state.moon, intensity: state.moon.intensity * direct },
    sky: {
      zenith: mix(
        state.sky.zenith,
        grey(state.sky.horizon, 0.85 * gloom),
        overcast,
      ),
      horizon: mix(state.sky.horizon, grey(state.sky.horizon, gloom), overcast),
    },
    ambient: mix(state.ambient, grey(state.ambient, gloom), overcast * 0.6),
    haze: clamp(
      state.haze +
        0.35 * w.fog +
        (w.precipitation ? 0.2 * w.precipitation.density : 0) +
        0.1 * cover,
      0,
      1,
    ),
    stars: state.stars * Math.pow(1 - cover, 2),
    // A shadow that faint is better gone than drawn as a smudge.
    shadow: direct < 0.35 ? null : state.shadow,
  };
}

// --- Clouds ------------------------------------------------------------------

/** One soft puff of cloud, in design pixels (1920×1080): a wide ellipse. */
export interface Puff {
  x: number;
  y: number;
  /** Half-height; puffs are CLOUD_ASPECT times as wide. */
  r: number;
  /** 0..1: lower puffs are the cloud's shaded underside. */
  shade: number;
}

/** Puffs are this much wider than tall: clouds flatten with distance. */
export const CLOUD_ASPECT = 1.7;

export interface CloudField {
  puffs: Puff[];
  /**
   * 0..1: an even sheet of stratus across the sky, under the puffs, as the
   * cover closes in: an overcast sky is grey from edge to edge.
   */
  deck: number;
}

const CLOUD_COUNT = 14;
/** Wide enough that wrapped clouds enter and leave off screen. */
const SPAN = 1920 + 900;
/**
 * The span the clouds wrap within, in design pixels: they are drawn once
 * at no drift (cloudField at minute 0) and moved as one, wrapping.
 */
export const CLOUD_SPAN = { left: -450, width: SPAN };
/** Design pixels a 1 m/s wind moves the clouds, per minute of the sky's clock. */
const DRIFT_PER_MINUTE = 2.5;
/**
 * Design pixels a 1 m/s wind moves the clouds per second while the scene
 * animates: a cloud a kilometre or two up crosses the view in minutes in
 * a breeze, in under a minute in a storm.
 */
export const CLOUD_SPEED = 0.8;

/** How far the clouds have drifted downwind by `minutes` (design pixels). */
export function cloudDrift(w: WeatherEffects, minutes: number): number {
  return w.windX * DRIFT_PER_MINUTE * minutes;
}

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * The cloud field: seeded clouds, each a cluster of overlapping soft
 * puffs, of which the first `cover` share are shown, so more cover adds
 * clouds and never moves the others; past half cover a stratus deck
 * closes over the sky. Drifts with the wind by `minutes` (since any fixed
 * instant).
 */
export function cloudField(w: WeatherEffects, minutes: number): CloudField {
  if (w.cloudCover <= 0.02) return { puffs: [], deck: 0 };
  const rand = random(19_850_314);
  const puffs: Puff[] = [];
  const shown = Math.round(CLOUD_COUNT * Math.min(1, w.cloudCover * 1.15));
  const drift = cloudDrift(w, minutes);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const base = rand() * SPAN;
    const y = 120 + rand() * 330;
    const width = 220 + rand() * 320;
    const height = width * (0.22 + rand() * 0.1);
    const count = 12 + Math.floor(rand() * 8);
    // Drawn whether shown or not, so each cloud keeps its shape.
    const parts = Array.from({ length: count }, () => [
      rand(),
      rand(),
      rand(),
      rand(),
    ]);
    if (i >= shown) continue;
    // Wrap within the span; puffs past the edges are simply off screen.
    const x = ((((base + drift) % SPAN) + SPAN) % SPAN) - 450;
    for (const [a = 0, a2 = 0, b = 0, c = 0] of parts) {
      // Bunched toward the middle, with a flat base and a rounded top.
      const along = (a + a2) / 2 - 0.5;
      const arch = 1 - Math.pow(along * 2, 2);
      puffs.push({
        x: x + along * width,
        y: y - b * height * arch,
        r: height * (0.35 + 0.35 * c) * (0.5 + 0.5 * arch),
        shade: clamp(0.25 + b * arch, 0, 1),
      });
    }
  }
  return { puffs, deck: smoothstep(0.5, 1, w.cloudCover) };
}

/**
 * Cloud colors under `state`: the tops lit by the Sun and sky, the
 * undersides darker, both greying as rain sets in. sRGB 0..1.
 */
export function cloudColors(
  state: LightingState,
  w: WeatherEffects,
): { top: Color; base: Color; alpha: number } {
  // Lit by the direct light that remains above the clouds, and the sky.
  const sun = state.sun.color.map(
    (v) => v * Math.min(1, state.sun.intensity * 1.6),
  ) as unknown as Color;
  const sky = state.ambient;
  const lit: Color = [
    Math.min(1, 0.55 * sky[0] + 0.5 * sun[0] + 0.04),
    Math.min(1, 0.55 * sky[1] + 0.5 * sun[1] + 0.04),
    Math.min(1, 0.55 * sky[2] + 0.5 * sun[2] + 0.05),
  ];
  const dark = 1 - 0.55 * w.cloudDarkness;
  const top = mix(lit, grey(lit), 0.4 * w.cloudDarkness);
  const base = top.map((v) => v * dark * 0.78) as unknown as Color;
  return { top, base, alpha: 0.55 + 0.4 * w.cloudCover };
}

// --- Rainbow -----------------------------------------------------------------

/**
 * How much direct Sun or Moon gets through the weather, 0.12..1: cloud
 * cover blocks it, overcast most of all, and fog a little more.
 */
export function directLight(w: WeatherEffects): number {
  const block = 0.8 * Math.pow(w.cloudCover, 1.5) + 0.1 * w.fog;
  return clamp(1 - block, 0.12, 1);
}

/** What makes a rainbow: where the Sun is, and how much light it sends. */
export interface Rainbow {
  /**
   * The point opposite the Sun, which the bow circles, placed on the
   * panorama like the Sun (lighting.ts `LightingState.antisolar`).
   */
  antisolar: { u: number; altitude: number };
  /** Brightness the bow adds at its peak, 0..1 of full white. */
  strength: number;
  /** The sunlight's colour (linear), reddened when the Sun is low. */
  tint: Color;
}

/**
 * A rainbow when sunlight falls on rain: liquid drops (not snow or sleet),
 * the Sun up, and gaps in the cloud for it to shine through. Where it
 * appears, and how large, is then geometry: circles about 42° and 51°
 * around the point opposite the Sun (rainbow.ts), so a higher Sun sinks
 * it. Never a report that one is seen.
 */
export function rainbow(
  state: LightingState,
  w: WeatherEffects,
): Rainbow | null {
  const p = w.precipitation;
  if (!p || p.type !== "rain") return null;
  // Past 42° the primary is below the horizon, past about 54° the
  // secondary too: it fades out over those last degrees rather than going
  // out at once.
  if (state.sun.altitude <= 0 || state.sun.altitude >= 64) return null;
  const setting = 1 - clamp((state.sun.altitude - 54) / 10, 0, 1);
  // Sunlight reaches the rain through gaps: none under a full deck.
  const gaps = clamp((0.95 - w.cloudCover) / 0.45, 0, 1);
  const risen = clamp(state.sun.altitude / 3, 0, 1);
  const strength =
    0.55 *
    risen *
    risen *
    (3 - 2 * risen) *
    setting *
    directLight(w) *
    gaps *
    (0.6 + 0.4 * p.density);
  if (strength < 0.01) return null;
  const linear = (v: number) => Math.pow(v, 2.2);
  return {
    antisolar: state.antisolar,
    strength,
    tint: [
      linear(state.sun.color[0]),
      linear(state.sun.color[1]),
      linear(state.sun.color[2]),
    ],
  };
}

// --- Precipitation -----------------------------------------------------------

/**
 * The most particles each tier draws at full density, per 1920×1080, under
 * the Balanced quality preset; the others scale them (src/ui/scene/quality.ts).
 */
export const PARTICLE_CAPS = {
  gpu: { rain: 900, sleet: 700, snow: 600 },
  software: { rain: 220, sleet: 180, snow: 160 },
} as const;

export interface ParticleField {
  type: Exclude<PrecipitationType, "none">;
  count: number;
  /** Fall speed, design pixels per second. */
  speed: number;
  /** Horizontal drift per unit of fall (the slant). */
  slant: number;
  /** Streak length (rain) or flake radius (snow), design pixels. */
  size: number;
  /** sRGB 0..1 and opacity. */
  color: Color;
  alpha: number;
}

/**
 * Particles for the tier: rain falls fast as streaks, snow slowly as
 * flakes, sleet in between. Wind slants them, up to about 50°. Lit by the
 * scene's light, so night rain is faint.
 */
export function particleField(
  state: LightingState,
  w: WeatherEffects,
  tier: keyof typeof PARTICLE_CAPS,
  /** The quality preset's share of the caps. */
  scale = 1,
): ParticleField | null {
  const p = w.precipitation;
  if (!p) return null;
  const count = Math.round(PARTICLE_CAPS[tier][p.type] * scale * p.density);
  if (count === 0) return null;
  const light = clamp(
    luma(state.ambient) * 0.8 + state.sun.intensity * 0.3 + 0.08,
    0.12,
    1,
  );
  const speed = p.type === "rain" ? 1500 : p.type === "sleet" ? 700 : 110;
  // Snow drifts farther in the same wind than fast-falling rain.
  const slant = clamp(
    (w.windX * (p.type === "snow" ? 30 : 9)) / speed,
    -1.2,
    1.2,
  );
  const tone = p.type === "rain" ? 0.78 : 0.97;
  return {
    type: p.type,
    count,
    speed,
    slant,
    size: p.type === "rain" ? 26 : p.type === "sleet" ? 3.2 : 2.6,
    color: [tone * light, tone * light, Math.min(1, tone * light * 1.04)],
    alpha: p.type === "rain" ? 0.45 : 0.85,
  };
}

export const PARTICLE_LOOP_SECONDS = 600;

/** A fraction of an integer hash, 0..1: the same in the GPU tier's shader. */
export function hash01(i: number, salt: number): number {
  let h = Math.imul(i ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * Where particle `i` is at `seconds`, in design pixels: each falls through
 * the stage from a seeded start and phase, wrapping top to bottom and side
 * to side, with a gentle seeded wobble for snow. The GPU tier's vertex
 * shader computes the same.
 */
export function particleAt(
  field: ParticleField,
  i: number,
  seconds: number,
): { x: number; y: number } {
  // Wrapped so single-precision shaders keep their accuracy on a monitor
  // left running for weeks; the jump every ten minutes is lost in the fall.
  seconds = seconds % PARTICLE_LOOP_SECONDS;
  const H = 1080 + 120;
  const W = 1920 + 200;
  const speed = field.speed * (0.8 + 0.4 * hash01(i, 3));
  const fall = (hash01(i, 2) * H + seconds * speed) % H;
  const wobble =
    field.type === "snow"
      ? 14 * Math.sin(seconds * (0.6 + hash01(i, 4)) + hash01(i, 5) * 6.283)
      : 0;
  const x =
    ((((hash01(i, 1) * W + fall * field.slant + wobble) % W) + W) % W) - 100;
  return { x, y: fall - 60 };
}
