import { describe, expect, it } from "vitest";
import { CREST } from "../../src/ui/scene/crest.ts";
import {
  crestAt,
  grassField,
  tuftPose,
  tuftSize,
  tuftSquash,
} from "../../src/ui/scene/grass.ts";
import { DESIGN } from "../../src/ui/scene/view.ts";
import { PRESETS } from "../../src/ui/scene/quality.ts";
import { MAX_WIND_STRENGTH, windStrength } from "../../src/ui/sway.ts";
import { WAVELENGTH, waveSpeed } from "../../src/ui/scene/wind-field.ts";

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
    // The budget measured on the Surface Pro (ADR 0021): about 7,400 tufts
    // at Balanced, which its HD 4000 draws at High's 30 frames a second.
    expect(grassField(PRESETS.balanced.grass.gpu).length).toBeLessThan(8000);
    // Software's, filled on the CPU without a GPU: about as much as the
    // first tufts (about two thirds of a screen of quads a frame).
    expect(grassField(PRESETS.balanced.grass.software).length).toBeLessThan(
      3500,
    );
  });

  it("leans downwind, further in stronger wind, within bounds", () => {
    const tuft = grassField(1)[500];
    if (!tuft) throw new Error("no tuft");
    const lean = (speed: number, windX: number, seconds: number | null) =>
      tuftPose(
        tuft,
        seconds,
        wind(speed, windX),
        windStrength(speed),
        MAX_WIND_STRENGTH,
      ).lean;
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
          tuftPose(
            tuft,
            s,
            wind(speed, speed, s * 100),
            windStrength(speed),
            MAX_WIND_STRENGTH,
          ).lean;
        most = Math.max(most, Math.abs(at(3) - at(0)));
      }
      return most;
    };
    expect(swing(0)).toBeGreaterThan(0.01);
    expect(swing(14)).toBeGreaterThan(swing(0) * 2);
  });

  it("moves with its neighbors, in waves rolling across the hill", () => {
    // Lean over a minute of a gale, for a tuft at (x, 1000).
    const series = (x: number) => {
      const tuft = { x, y: 1000, size: 60, kind: 1, flip: false, seed: 0.37 };
      return Array.from({ length: 240 }, (_, i) => {
        const s = i * 0.25;
        return tuftPose(
          tuft,
          s,
          wind(14, 14, s * waveSpeed(14)),
          windStrength(14),
          MAX_WIND_STRENGTH,
        ).lean;
      });
    };
    const correlation = (a: number[], b: number[]) => {
      const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
      const [ma, mb] = [mean(a), mean(b)];
      let ab = 0;
      let aa = 0;
      let bb = 0;
      a.forEach((v, i) => {
        const w = (b[i] ?? 0) - mb;
        ab += (v - ma) * w;
        aa += (v - ma) ** 2;
        bb += w * w;
      });
      return ab / Math.sqrt(aa * bb);
    };
    const here = series(600);
    // Neighbors a tuft's width apart lean almost as one; tufts half a wave
    // apart do not.
    expect(correlation(here, series(615))).toBeGreaterThan(0.9);
    expect(correlation(here, series(600 + WAVELENGTH / 2))).toBeLessThan(0.5);
    // The wave travels downwind: a tuft downwind leans as this one did a
    // moment before.
    const later = series(700);
    const lagged = (lag: number) =>
      correlation(here.slice(0, 240 - lag), later.slice(lag));
    expect(lagged(2)).toBeGreaterThan(lagged(0));
  });

  it("lights bent grass and shades upright grass only while it moves", () => {
    const tuft = grassField(1)[800];
    if (!tuft) throw new Error("no tuft");
    const pose = (seconds: number | null) =>
      tuftPose(
        tuft,
        seconds,
        wind(12, 12, (seconds ?? 0) * 150),
        windStrength(12),
        MAX_WIND_STRENGTH,
      );
    expect(pose(null).lift).toBe(0);
    const steady = pose(null).lean;
    let lifted = 0;
    for (let s = 0; s < 60; s += 0.5) {
      const { lean, lift } = pose(s);
      expect(Math.abs(lift)).toBeLessThanOrEqual(1);
      // Bent further than its steady lean: paler; less: darker.
      if (Math.abs(lift) > 0.2)
        expect(Math.sign(lean - steady)).toBe(Math.sign(lift));
      if (Math.abs(lift) > 0.2) lifted++;
    }
    expect(lifted).toBeGreaterThan(10);
  });

  it("keeps a leaning tuft's blades their length", () => {
    expect(tuftSquash(0)).toBe(1);
    for (const lean of [0.3, -0.6, 0.9])
      expect(Math.hypot(lean, 1) * tuftSquash(lean)).toBeCloseTo(1, 10);
  });
});
