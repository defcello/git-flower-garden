import { describe, expect, it } from "vitest";
import { CREST } from "../../src/ui/scene/crest.ts";
import {
  crestAt,
  grassField,
  tuftLean,
  tuftSize,
  tuftSquash,
} from "../../src/ui/scene/grass.ts";
import { DESIGN } from "../../src/ui/scene/view.ts";
import { PRESETS } from "../../src/ui/scene/quality.ts";
import { MAX_WIND_STRENGTH, windStrength } from "../../src/ui/sway.ts";

const wind = (speed: number, windX: number, travel = 0) => ({
  speed,
  windX,
  travel,
});

describe("grass tufts (ADR 0021)", () => {
  it("follows the ground layer's crest", () => {
    // From about 0.76 of the height at the edges to 0.62 in the middle.
    expect(crestAt(0)).toBeCloseTo(CREST[0] ?? 0, 5);
    expect(crestAt(0) / DESIGN.height).toBeGreaterThan(0.74);
    expect(crestAt(DESIGN.width / 2) / DESIGN.height).toBeLessThan(0.64);
    expect(crestAt(-50)).toBe(crestAt(0));
  });

  it("plants every tuft on the hill, back to front, deterministically", () => {
    const tufts = grassField(1);
    expect(grassField(1)).toBe(tufts);
    for (let i = 1; i < tufts.length; i++)
      expect(tufts[i]?.y).toBeGreaterThanOrEqual(tufts[i - 1]?.y ?? 0);
    for (const tuft of tufts) {
      const x = Math.min(DESIGN.width, Math.max(0, tuft.x));
      expect(tuft.y).toBeGreaterThanOrEqual(crestAt(x) - 1e-6);
      expect(tuft.kind).toBeGreaterThanOrEqual(0);
      expect(tuft.kind).toBeLessThan(4);
    }
    // Every kind appears, mirrored and not.
    expect(new Set(tufts.map((t) => t.kind)).size).toBe(4);
    expect(tufts.some((t) => t.flip) && tufts.some((t) => !t.flip)).toBe(true);
  });

  it("grows larger toward the viewer, and covers the whole width", () => {
    expect(tuftSize(0)).toBeLessThan(tuftSize(0.5));
    expect(tuftSize(0.5)).toBeLessThan(tuftSize(1));
    const tufts = grassField(1);
    const far = tufts.filter((t) => t.y < 760);
    const near = tufts.filter((t) => t.y > 1000);
    const mean = (ts: typeof tufts) =>
      ts.reduce((sum, t) => sum + t.size, 0) / ts.length;
    expect(mean(near)).toBeGreaterThan(mean(far) * 3);
    for (let x = 0; x < DESIGN.width; x += 100)
      expect(near.some((t) => Math.abs(t.x - x) < 100)).toBe(true);
  });

  it("spaces tufts out for lighter tiers and presets", () => {
    const counts = [1, 0.75, 0.5].map((d) => grassField(d).length);
    expect(counts[0]).toBeGreaterThan(counts[1] ?? 0);
    expect(counts[1]).toBeGreaterThan(counts[2] ?? 0);
    // A budget the Surface Pro's Software tier keeps up with (ADR 0021).
    expect(grassField(PRESETS.balanced.grass).length).toBeLessThan(2000);
  });

  it("leans downwind, further in stronger wind, within bounds", () => {
    const tuft = grassField(1)[500];
    if (!tuft) throw new Error("no tuft");
    const lean = (speed: number, windX: number, seconds: number | null) =>
      tuftLean(
        tuft,
        seconds,
        wind(speed, windX),
        windStrength(speed),
        MAX_WIND_STRENGTH,
      );
    // At rest, the wind's steady push: right in a wind blowing right.
    expect(lean(12, 12, null)).toBeGreaterThan(0);
    expect(lean(12, -12, null)).toBeLessThan(0);
    expect(lean(12, 12, null)).toBeGreaterThan(lean(2, 2, null));
    // Over a minute, on average downwind, and always within ±0.9.
    for (const windX of [12, -12]) {
      let sum = 0;
      for (let s = 0; s < 60; s += 0.25) {
        const l = lean(12, windX, s);
        expect(Math.abs(l)).toBeLessThanOrEqual(0.9);
        sum += l;
      }
      expect(Math.sign(sum)).toBe(Math.sign(windX));
    }
  });

  it("moves with the gusts, and more in a gale than in calm air", () => {
    const tufts = grassField(1).slice(0, 400);
    const swing = (speed: number) => {
      let most = 0;
      for (const tuft of tufts) {
        const at = (s: number) =>
          tuftLean(
            tuft,
            s,
            wind(speed, speed, s * 100),
            windStrength(speed),
            MAX_WIND_STRENGTH,
          );
        most = Math.max(most, Math.abs(at(3) - at(0)));
      }
      return most;
    };
    expect(swing(0)).toBeGreaterThan(0.01);
    expect(swing(14)).toBeGreaterThan(swing(0) * 2);
  });

  it("keeps a leaning tuft's blades their length", () => {
    expect(tuftSquash(0)).toBe(1);
    for (const lean of [0.3, -0.6, 0.9])
      expect(Math.hypot(lean, 1) * tuftSquash(lean)).toBeCloseTo(1, 10);
  });
});
