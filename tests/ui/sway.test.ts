import { describe, expect, it } from "vitest";
import type { Sprite } from "../../src/ui/botanical.ts";
import {
  FRAME_MS,
  PROBE_FRAMES,
  PROBE_LIMIT_MS,
  SWAY_ANGLE,
  swayAngle,
  swaySprites,
  tooSlow,
} from "../../src/ui/sway.ts";

const sprite = (
  key: string,
  x = 40,
  rotate = 0.2,
): Sprite & { scale: number } => ({
  key,
  kind: 2,
  x,
  y: 100,
  size: 24,
  rotate,
  flip: false,
  scale: 1,
});

describe("sway", () => {
  it("rests exactly when stopped", () => {
    const sprites = [sprite("a"), sprite("b")];
    expect(swaySprites(sprites, null)).toBe(sprites);
  });

  it("stays within its angle and is the same for the same moment", () => {
    for (let t = 0; t < 30; t += 0.37) {
      const angle = swayAngle(sprite("leaf:1"), t);
      expect(Math.abs(angle)).toBeLessThanOrEqual(SWAY_ANGLE);
      expect(swayAngle(sprite("leaf:1"), t)).toBe(angle);
    }
  });

  it("does not move neighbors in lockstep", () => {
    // Twenty leaves side by side on one stem, at one moment.
    const angles = Array.from({ length: 20 }, (_, i) =>
      swayAngle(sprite(`leaf:${String(i)}`), 2.5),
    );
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(
      SWAY_ANGLE / 2,
    );
  });

  it("turns each sprite about the bottom of its cell", () => {
    const rest = sprite("flower:main", 40, 0.2);
    const [moved] = swaySprites([rest], 1.7);
    if (!moved) throw new Error("no sprite");
    expect(moved.rotate).not.toBe(rest.rotate);
    // The pivot (half a sprite below the center, in the sprite's frame)
    // stays put, so the sprite never leaves its stem.
    const pivot = (s: Sprite & { scale: number }) => {
      const arm = (s.size * s.scale) / 2;
      return {
        x: s.x - arm * Math.sin(s.rotate),
        y: s.y + arm * Math.cos(s.rotate),
      };
    };
    expect(pivot(moved).x).toBeCloseTo(pivot(rest).x, 9);
    expect(pivot(moved).y).toBeCloseTo(pivot(rest).y, 9);
    // Everything else is unchanged.
    expect({ ...moved, x: 0, y: 0, rotate: 0 }).toEqual({
      ...rest,
      x: 0,
      y: 0,
      rotate: 0,
    });
  });
});

describe("frame-time probe", () => {
  it("waits for enough frames", () => {
    expect(tooSlow(Array<number>(PROBE_FRAMES - 1).fill(500))).toBe(false);
  });

  it("keeps sway at the cap and tolerates a few late frames", () => {
    const gaps = Array<number>(PROBE_FRAMES).fill(FRAME_MS);
    gaps.fill(400, 0, PROBE_FRAMES / 2 - 1);
    expect(tooSlow(gaps)).toBe(false);
  });

  it("stops sway when most frames run late", () => {
    expect(tooSlow(Array<number>(PROBE_FRAMES).fill(PROBE_LIMIT_MS + 1))).toBe(
      true,
    );
  });
});
