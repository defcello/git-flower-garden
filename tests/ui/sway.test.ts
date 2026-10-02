import { describe, expect, it } from "vitest";
import type { Sprite } from "../../src/ui/botanical.ts";
import {
  FRAME_MS,
  MAX_WIND_STRENGTH,
  PROBE_FRAMES,
  PROBE_LIMIT_MS,
  SWAY_ANGLE,
  swayAngle,
  setSwayWind,
  swaySprites,
  swayWind,
  tooBusy,
  tooSlow,
  windStrength,
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

describe("wind (ADR 0018 step 5)", () => {
  it("sways harder in wind, within a restrained limit", () => {
    expect(windStrength(4)).toBeCloseTo(1, 9);
    expect(windStrength(0)).toBeLessThan(1);
    expect(windStrength(16)).toBeGreaterThan(1.5);
    expect(windStrength(60)).toBe(MAX_WIND_STRENGTH);
    expect(SWAY_ANGLE * MAX_WIND_STRENGTH).toBeLessThan(0.14); // about 7.5°
    const leaf = sprite("leaf:1");
    for (let t = 0; t < 10; t += 0.7)
      expect(swayAngle(leaf, t, 2)).toBeCloseTo(2 * swayAngle(leaf, t), 12);
  });

  it("follows the weather's wind, and the calm breeze without weather", () => {
    const rest = [sprite("leaf:1")];
    const angle = () => (swaySprites(rest, 1.3)[0]?.rotate ?? 0) - 0.2;
    try {
      setSwayWind(null);
      const breeze = angle();
      setSwayWind(16);
      expect(Math.abs(angle())).toBeGreaterThan(Math.abs(breeze) * 1.5);
      setSwayWind(0);
      expect(Math.abs(angle())).toBeLessThan(Math.abs(breeze));
    } finally {
      setSwayWind(null);
    }
  });

  it("keeps the travelled wave when only the wind speed changes", () => {
    setSwayWind(4, -4);
    const before = swayWind(1000);
    setSwayWind(9, -9);
    expect(swayWind(1000).travel).toBe(before.travel);
    expect(swayWind(1000).windX).toBe(-9);
    setSwayWind(null);
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

  it("finds a fast preset too busy when drawing takes over half a frame", () => {
    const high = 1000 / 30;
    expect(tooBusy(Array<number>(PROBE_FRAMES - 1).fill(30), high)).toBe(false);
    expect(tooBusy(Array<number>(PROBE_FRAMES).fill(high / 2 - 1), high)).toBe(
      false,
    );
    expect(tooBusy(Array<number>(PROBE_FRAMES).fill(high / 2 + 1), high)).toBe(
      true,
    );
  });

  it("judges a faster preset's frames against its own rate", () => {
    const high = 1000 / 30;
    // On time for Balanced, but twice High's gap: too slow at 30 fps.
    const gaps = Array<number>(PROBE_FRAMES).fill(FRAME_MS);
    expect(tooSlow(gaps)).toBe(false);
    expect(tooSlow(gaps, high)).toBe(true);
    expect(tooSlow(Array<number>(PROBE_FRAMES).fill(high), high)).toBe(false);
  });
});
