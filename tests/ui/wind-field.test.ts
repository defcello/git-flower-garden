import { describe, expect, it } from "vitest";
import {
  advance,
  gustEnvelope,
  gustPatch,
  gustsOf,
  waveShape,
  waveSpeed,
  wavePeriod,
  WAVELENGTH,
  windDirection,
  windWave,
  TRAVEL_WRAP,
} from "../../src/ui/scene/wind-field.ts";

const correlation = (a: number[], b: number[], offset: number) => {
  let score = 0;
  for (let i = 12; i < a.length - 12; i++)
    score += (a[i] ?? 0) * (b[i + offset] ?? 0);
  return score;
};
const bestOffset = (a: number[], b: number[]) => {
  let best = -Infinity,
    offset = 0;
  for (let shift = -10; shift <= 10; shift++) {
    const score = correlation(a, b, shift);
    if (score > best) {
      best = score;
      offset = shift;
    }
  }
  return offset;
};

describe("wind field", () => {
  it("is deterministic and bounded across the hill and through the wrap", () => {
    for (const speed of [0, 4, 12, 50])
      for (let t = 0; t < 40; t += 0.7)
        for (const y of [650, 840, 1080]) {
          const wind = { speed, windX: -speed, travel: t * waveSpeed(speed) };
          const bend = windWave(723, y, t, wind);
          expect(Math.abs(bend)).toBeLessThanOrEqual(1);
          expect(windWave(723, y, t, wind)).toBe(bend);
        }
    const wind = { speed: 12, windX: -12, travel: 0 };
    expect(waveShape(810, 900, { ...wind, travel: TRAVEL_WRAP })).toBeCloseTo(
      waveShape(810, 900, wind),
      7,
    );
  });

  it("moves features and gust patches downwind in either direction", () => {
    for (const direction of [-1, 1]) {
      const wind = { speed: 8, windX: direction * 8, travel: 100 };
      const next = { ...wind, travel: wind.travel + 80 };
      const xs = Array.from({ length: 160 }, (_, i) => i * 20);
      const oldBase = xs.map((x) => waveShape(x, 1080, wind));
      const newBase = xs.map((x) => waveShape(x, 1080, next));
      const oldPatch = xs.map((x) => gustPatch(x, 1080, wind) - 0.5);
      const newPatch = xs.map((x) => gustPatch(x, 1080, next) - 0.5);
      expect(Math.sign(bestOffset(oldBase, newBase))).toBe(direction);
      expect(Math.sign(bestOffset(oldPatch, newPatch))).toBe(direction);
    }
  });

  it("deepens lulls with wind while calm air continues drifting", () => {
    expect(waveSpeed(12)).toBeGreaterThan(waveSpeed(2));
    // Fronts pass more often as the wind rises, a fixed WAVELENGTH apart.
    for (let v = 0; v < 40; v++)
      expect(wavePeriod(v + 1)).toBeLessThan(wavePeriod(v));
    expect(wavePeriod(0)).toBeCloseTo(16, 5);
    expect(wavePeriod(40)).toBeGreaterThan(2);
    expect(waveSpeed(4) * wavePeriod(4)).toBeCloseTo(WAVELENGTH, 5);
    const calm = Array.from({ length: 300 }, (_, i) => gustEnvelope(i, 0));
    const windy = Array.from({ length: 300 }, (_, i) => gustEnvelope(i, 12));
    expect(Math.min(...windy)).toBeLessThan(0.4);
    expect(Math.min(...calm)).toBeGreaterThan(0.95);
    expect(windDirection(0)).toBe(1);
    expect(waveShape(800, 900, { speed: 0, windX: 0, travel: 0 })).not.toBe(
      waveShape(800, 900, { speed: 0, windX: 0, travel: 20 }),
    );
  });

  it("does not jump at a speed change; wrapping keeps the same lattice", () => {
    const before = advance(300, 0.1, 3);
    const changed = { speed: 10, windX: 10, travel: before };
    expect(
      windWave(700, 900, 8, changed) / gustEnvelope(8, gustsOf(10)),
    ).toBeCloseTo(
      windWave(700, 900, 8, { ...changed, speed: 3 }) /
        gustEnvelope(8, gustsOf(3)),
      12,
    );
    expect(advance(TRAVEL_WRAP - 1, 0.2, 12)).toBeLessThan(waveSpeed(12));
    expect(advance(0, 1000, 12)).toBeLessThan(waveSpeed(12));
  });
});
