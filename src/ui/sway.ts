/*
 * Restrained wind sway for the garden's artwork (ADR 0018, "Software tier";
 * roadmap P2-C): each leaf, flower, and fruit rocks gently about the point
 * where it meets its stem, as if pivoting there. Only sprites move; stems,
 * knots, and every hit target stay exactly where the graph puts them. The
 * field's math is pure; this module keeps the travelled distance shared by
 * the landscape and plants.
 */
import { seeded, type Sprite } from "./botanical.ts";
import { CLOUD_SPAN, CLOUD_SPEED } from "../environment/weather-effects.ts";
import {
  advance,
  gustsOf,
  windDirection,
  windWave,
  type WindField,
} from "./scene/wind-field.ts";

/**
 * Largest rocking angle in the calm breeze, in radians (about 8°): enough
 * that leaves and flowers visibly swing with the waves rolling through the
 * grass, though they pivot where they meet the stem.
 */
export const SWAY_ANGLE = 0.14;
/** How far the breeze leans every sprite downwind, in radians (about 3.4°). */
export const WIND_LEAN = 0.06;
/** Seconds per sway, the slowest and fastest. */
const PERIOD_MIN = 3.2;
const PERIOD_MAX = 5.2;
let wind: WindField = { speed: 4, windX: 0, travel: 0 };
let windAt: number | null = null;

/** How far the clouds have moved on the clock, design pixels (CLOUD_SPEED). */
let clouds = 0;

/** One distance for every listener on the shared clock. Earlier clock readings do not rewind travel. */
export function swayWind(seconds: number): WindField {
  if (windAt !== null && seconds > windAt) {
    wind.travel = advance(wind.travel, seconds - windAt, wind.speed);
    // The clouds go with the wind's speed; which way across the sky for
    // now only left or right (a wind into the scene carries them right).
    const step = Math.min(0.25, seconds - windAt);
    clouds =
      (clouds + step * CLOUD_SPEED * windDirection(wind.windX) * wind.speed) %
      CLOUD_SPAN.width;
  }
  windAt = seconds;
  return wind;
}

/** How far the clouds have moved while the scene animated, design pixels. */
export function cloudTravel(): number {
  return clouds;
}

/**
 * The sway angle of one sprite at `seconds`. The wind field at `position`
 * (the sprite's place on the hillside) brings the gusts that roll through
 * the grass, and each sprite adds its own seeded rhythm, so neighbors never
 * move in lockstep; a wind across the view leans them all downwind, more
 * as each gust arrives. Always within ±(SWAY_ANGLE + WIND_LEAN) ×
 * `strength` (the wind).
 */
export function swayAngle(
  sprite: Sprite,
  seconds: number,
  strength = 1,
  position: { x: number; y: number } = sprite,
): number {
  const seed = seeded(`${sprite.key}|sway`);
  const period = PERIOD_MIN + (PERIOD_MAX - PERIOD_MIN) * seed;
  const own = Math.sin((2 * Math.PI * seconds) / period + seed * 2 * Math.PI);
  const wind = swayWind(seconds);
  const field = windWave(position.x, position.y, seconds, wind);
  // Across the view only: a wind into the scene or toward the viewer
  // leans nothing sideways.
  const across =
    Math.abs(wind.windX) > 0.15
      ? wind.windX / Math.hypot(wind.windX, wind.windZ ?? 0)
      : 0;
  const lean = WIND_LEAN * across * (0.5 + 0.5 * Math.max(0, field));
  return strength * (SWAY_ANGLE * (0.35 * own + 0.65 * field) + lean);
}

/** The strongest wind sway, relative to the calm breeze (about 26° at most). */
export const MAX_WIND_STRENGTH = 2.2;

/** The largest angle any sprite turns, radians (swayAngle at MAX_WIND_STRENGTH). */
export const MAX_SWAY = (SWAY_ANGLE + WIND_LEAN) * MAX_WIND_STRENGTH;

/**
 * How strongly the garden sways in a wind of `metersPerSecond`: a light
 * breeze is the calm default (1 at about 4 m/s), still air a little less,
 * and a gale at most MAX_WIND_STRENGTH, so it stays restrained.
 */
export function windStrength(metersPerSecond: number): number {
  const v = Math.max(0, metersPerSecond);
  return Math.min(MAX_WIND_STRENGTH, 0.6 + 0.1 * v);
}

let currentStrength = 1;

/** The wind now, without moving the waves on (for poses at rest). */
export function currentWind(): WindField {
  return wind;
}

/** How strongly the garden sways in the current wind (windStrength). */
export function swayStrength(): number {
  return currentStrength;
}

/**
 * Set the wind the garden sways in (null: no weather; the field keeps a
 * default 4 m/s breeze): its speed, where it blows on the ground (m/s to
 * the right and away from the viewer), and its gusts (m/s above the mean;
 * by default, wind-field.ts gustsOf).
 */
export function setSwayWind(
  metersPerSecond: number | null,
  windX = 0,
  windZ = 0,
  gust?: number,
): void {
  currentStrength =
    metersPerSecond === null ? 1 : windStrength(metersPerSecond);
  const speed = metersPerSecond ?? 4;
  wind = { ...wind, speed, windX, windZ, gust: gust ?? gustsOf(speed) };
}

/**
 * Sprites at `seconds`: each turned by its sway angle about the bottom of
 * its cell (where it grows from the stem), so the drawn center shifts along
 * an arc and the rotation grows by the same angle. `null` is the rest pose.
 */
export function swaySprites<T extends Sprite & { scale: number }>(
  sprites: readonly T[],
  seconds: number | null,
  strength = currentStrength,
  place: (sprite: T) => { x: number; y: number } = (sprite) => sprite,
): readonly T[] {
  if (seconds === null) return sprites;
  return sprites.map((sprite) => {
    const angle = swayAngle(sprite, seconds, strength, place(sprite));
    // The pivot sits half a (scaled) sprite below the center, in the
    // sprite's own rotated frame.
    const arm = (sprite.size * sprite.scale) / 2;
    const turn = sprite.rotate + angle;
    return {
      ...sprite,
      x: sprite.x + arm * (Math.sin(turn) - Math.sin(sprite.rotate)),
      y: sprite.y - arm * (Math.cos(turn) - Math.cos(sprite.rotate)),
      rotate: turn,
    };
  });
}

/**
 * The Balanced preset's animation rate (ADR 0018: initially 15 fps), and the
 * rate a faster preset falls back to when frames run late (motion.ts).
 */
export const SOFTWARE_FPS = 15;
export const FRAME_MS = 1000 / SOFTWARE_FPS;

/** Frames the probe looks at, and how late their median may run. */
export const PROBE_FRAMES = 30;
export const PROBE_LIMIT_MS = FRAME_MS * 1.5;

/**
 * The probe's verdict on the gaps between recent frames, drawn every
 * `frameMs`: too slow when their median runs past one and a half frames.
 * Pure, for tests.
 */
export function tooSlow(gaps: readonly number[], frameMs = FRAME_MS): boolean {
  if (gaps.length < PROBE_FRAMES) return false;
  return median(gaps) > frameMs * 1.5;
}

/**
 * Whether drawing the frames takes too much of the time between them: the
 * median script time of recent frames past half of `frameMs`. Frames can
 * arrive nearly on time while painting leaves the page little time for
 * anything else (Software at 4K on a 2-core laptop), so a preset faster
 * than Balanced steps down on this too. Pure, for tests.
 */
export function tooBusy(works: readonly number[], frameMs: number): boolean {
  if (works.length < PROBE_FRAMES) return false;
  return median(works) > frameMs / 2;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
