/*
 * Restrained wind sway for the garden's artwork (ADR 0018, "Software tier";
 * roadmap P2-C): each leaf, flower, and fruit rocks gently about the point
 * where it meets its stem, as if pivoting there. Only sprites move; stems,
 * knots, and every hit target stay exactly where the graph puts them. Pure,
 * so any moment of the sway is testable.
 */
import { seeded, type Sprite } from "./botanical.ts";

/** Largest rocking angle, in radians (about 3.4°). */
export const SWAY_ANGLE = 0.06;
/** Seconds per sway, the slowest and fastest. */
const PERIOD_MIN = 3.2;
const PERIOD_MAX = 5.2;
/** Seconds for a breeze to cross 1,000 px of garden, left to right. */
const GUST_CROSSING = 6;

/**
 * The sway angle of one sprite at `seconds`. A slow breeze sweeps across
 * the garden and each sprite adds its own seeded rhythm, so neighbors never
 * move in lockstep. Always within ±SWAY_ANGLE × `strength` (the wind).
 */
export function swayAngle(
  sprite: Sprite,
  seconds: number,
  strength = 1,
): number {
  const seed = seeded(`${sprite.key}|sway`);
  const period = PERIOD_MIN + (PERIOD_MAX - PERIOD_MIN) * seed;
  const own = Math.sin((2 * Math.PI * seconds) / period + seed * 2 * Math.PI);
  const breeze = Math.sin(
    (2 * Math.PI * (seconds - (sprite.x / 1000) * GUST_CROSSING)) / 9,
  );
  return SWAY_ANGLE * strength * (0.6 * own + 0.4 * breeze);
}

/** The strongest wind sway, relative to the calm breeze (about 7.5°). */
export const MAX_WIND_STRENGTH = 2.2;

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

/** Set the wind the garden sways in (null: no weather, the calm breeze). */
export function setSwayWind(metersPerSecond: number | null): void {
  currentStrength =
    metersPerSecond === null ? 1 : windStrength(metersPerSecond);
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
): readonly T[] {
  if (seconds === null) return sprites;
  return sprites.map((sprite) => {
    const angle = swayAngle(sprite, seconds, strength);
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

/** The software tier's animation cap (ADR 0018: initially 15 fps). */
export const SOFTWARE_FPS = 15;
export const FRAME_MS = 1000 / SOFTWARE_FPS;

/** Frames the probe looks at, and how late their median may run. */
export const PROBE_FRAMES = 30;
export const PROBE_LIMIT_MS = FRAME_MS * 1.5;

/**
 * The probe's verdict on the gaps between recent frames: too slow when
 * their median runs past the limit. Pure, for tests.
 */
export function tooSlow(gaps: readonly number[]): boolean {
  if (gaps.length < PROBE_FRAMES) return false;
  const sorted = [...gaps].sort((a, b) => a - b);
  return (sorted[Math.floor(sorted.length / 2)] ?? 0) > PROBE_LIMIT_MS;
}
