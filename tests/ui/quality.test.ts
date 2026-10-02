import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY,
  PRESETS,
  QUALITIES,
} from "../../src/ui/scene/quality.ts";
import { SOFTWARE_FPS } from "../../src/ui/sway.ts";

describe("quality presets", () => {
  it("defaults to High", () => {
    expect(DEFAULT_QUALITY).toBe("high");
    expect(QUALITIES).toEqual(["low", "balanced", "high"]);
  });

  it("keeps Balanced as the garden was before presets", () => {
    expect(PRESETS.balanced).toEqual({
      fps: SOFTWARE_FPS,
      pixelRatio: 2,
      particles: { gpu: 1, software: 1 },
      sway: true,
    });
  });

  it("orders the presets from least to most work", () => {
    const { low, balanced, high } = PRESETS;
    for (const [less, more] of [
      [low, balanced],
      [balanced, high],
    ] as const) {
      expect(less.fps).toBeLessThan(more.fps);
      expect(less.pixelRatio).toBeLessThanOrEqual(more.pixelRatio);
      expect(less.particles.gpu).toBeLessThanOrEqual(more.particles.gpu);
      expect(less.particles.software).toBeLessThanOrEqual(
        more.particles.software,
      );
    }
    expect(low.sway).toBe(false);
    expect(high.sway).toBe(true);
  });

  it("never asks for more than a pixel ratio of 2 (ADR 0018, Resolution)", () => {
    for (const q of QUALITIES)
      expect(PRESETS[q].pixelRatio).toBeLessThanOrEqual(2);
  });
});
