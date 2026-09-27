/*
 * Brief growth and movement between two botanical scenes (roadmap P2-B):
 * new stems, knots, leaves, flowers, and fruit fade and grow in; a flower
 * whose ref moved glides to its new commit; removed history fades out. Only
 * the artwork moves; the interaction layer is always at its final, exact
 * positions. Pure, so every frame is testable.
 */
import type { Ground, Knot, Scene, Sprite, Stem } from "./botanical.ts";

export interface Frame {
  stems: (Stem & { alpha: number })[];
  knots: (Knot & { alpha: number })[];
  sprites: (Sprite & { alpha: number; scale: number })[];
  grounds: (Ground & { alpha: number })[];
}

export const TRANSITION_MS = 700;

/** Ease out: fast start, gentle settle. */
export function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function byKey<T extends { key: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.key, item]));
}

/**
 * The frame at progress `t` (0 to 1) of the transition from `from` to `to`.
 * With no previous scene, or at t = 1, it is exactly `to`.
 */
export function blendScenes(from: Scene | null, to: Scene, t: number): Frame {
  const k = from === null ? 1 : ease(t);
  const done = k >= 1;
  const prevStems = byKey(from?.stems ?? []);
  const prevKnots = byKey(from?.knots ?? []);
  const prevSprites = byKey(from?.sprites ?? []);
  const nextStems = byKey(to.stems);
  const nextKnots = byKey(to.knots);
  const nextSprites = byKey(to.sprites);

  const stems: Frame["stems"] = to.stems.map((stem) => ({
    ...stem,
    alpha: prevStems.has(stem.key) ? 1 : k,
  }));
  const knots: Frame["knots"] = to.knots.map((knot) => ({
    ...knot,
    alpha: prevKnots.has(knot.key) ? 1 : k,
  }));
  const sprites: Frame["sprites"] = to.sprites.map((sprite) => {
    const before = prevSprites.get(sprite.key);
    if (!before) return { ...sprite, alpha: k, scale: 0.4 + 0.6 * k };
    return {
      ...sprite,
      x: lerp(before.x, sprite.x, k),
      y: lerp(before.y, sprite.y, k),
      rotate: lerp(before.rotate, sprite.rotate, k),
      alpha: 1,
      scale: 1,
    };
  });
  const grounds: Frame["grounds"] = to.grounds.map((ground) => ({
    ...ground,
    alpha: 1,
  }));
  if (!done && from) {
    // Removed history fades out beneath what remains.
    for (const stem of from.stems)
      if (!nextStems.has(stem.key)) stems.unshift({ ...stem, alpha: 1 - k });
    for (const knot of from.knots)
      if (!nextKnots.has(knot.key)) knots.unshift({ ...knot, alpha: 1 - k });
    for (const sprite of from.sprites)
      if (!nextSprites.has(sprite.key))
        sprites.unshift({ ...sprite, alpha: 1 - k, scale: 1 });
  }
  return { stems, knots, sprites, grounds };
}
