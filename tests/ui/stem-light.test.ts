import { describe, expect, it } from "vitest";
import { lightingState } from "../../src/environment/lighting.ts";
import { previewSnapshot } from "../../src/environment/overrides.ts";
import {
  BOUNDARY_COLOR,
  HALO_COLOR,
  KNOT_COLOR,
  STEM_COLOR,
} from "../../src/ui/botanical.ts";
import { litColor, sceneLight, stemLight } from "../../src/ui/scene/view.ts";

/**
 * The GPU tier lights its unlit stem textures by multiplying each linear
 * channel by `stemLight` (scene/plants-gpu.ts); the software tier paints
 * stems in `litColor`. They must agree.
 */
describe("stemLight", () => {
  const gpuColor = (hex: string, light: [number, number, number]) => {
    const srgb = [0, 1, 2].map((i) => {
      const unlit = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      const lit = Math.pow(unlit, 2.2) * (light[i] ?? 0);
      return Math.round(Math.pow(Math.min(1, Math.max(0, lit)), 1 / 2.2) * 255);
    });
    return `rgb(${srgb.map(String).join(" ")})`;
  };

  for (const preview of [
    "noon",
    "sunrise",
    "civil-dusk",
    "full-moon",
    "night",
  ] as const)
    it(`lights stems as litColor does at ${preview}`, () => {
      const p = sceneLight(lightingState(previewSnapshot(preview)));
      const light = stemLight(p);
      for (const hex of [STEM_COLOR, KNOT_COLOR, HALO_COLOR, BOUNDARY_COLOR])
        expect(gpuColor(hex, light), hex).toBe(litColor(hex, p));
    });
});
