import { describe, expect, it } from "vitest";
import {
  advance,
  gustEnvelope,
  gustPatch,
  waveShape,
  waveSpeed,
  windDirection,
  windWave,
  WIND_GLSL,
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

// JS evaluation of the shader's lattice and sampling expression. The hash uses
// the same unsigned 32-bit operations as GLSL, so this also tests wrap parity.
function shaderField(
  x: number,
  y: number,
  seconds: number,
  speed: number,
  windX: number,
  travel: number,
): number {
  const fract = (v: number) => v - Math.floor(v);
  const hash = (x: number, y: number) => {
    x = ((x % 128) + 128) % 128;
    y = ((y % 128) + 128) % 128;
    let h = (Math.imul(x, 1664525) + Math.imul(y, 1013904223)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return (h & 65535) / 65535;
  };
  const sample = (x: number, y: number) => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = fract(x),
      fy = fract(y);
    const ux = fx * fx * (3 - 2 * fx),
      uy = fy * fy * (3 - 2 * fy);
    const lo = hash(ix, iy) * (1 - ux) + hash(ix + 1, iy) * ux;
    const hi = hash(ix, iy + 1) * (1 - ux) + hash(ix + 1, iy + 1) * ux;
    return lo * (1 - uy) + hi * uy;
  };
  const depth = 0.6 + 0.4 * Math.max(0, Math.min(1, (y - 650) / 430));
  const qx = (x - 960) / depth,
    qy = (y - 650) / depth;
  const d = Math.abs(windX) > 0.15 ? Math.sign(windX) : 1;
  const base =
    0.72 * sample((qx - d * travel) / 250, qy / 160) +
    0.28 *
      sample((qx - d * travel * 0.75) / 125 + 19.7, qy / 80 + travel / 2000);
  const patch = sample((qx - d * travel * 1.5) / 500 + 31.3, qy / 320 + 7.1);
  const pulse =
    0.5 * Math.sin((2 * Math.PI * seconds) / 11) +
    0.32 * Math.sin((2 * Math.PI * seconds) / 17 + 0.9) +
    0.18 * Math.sin((2 * Math.PI * seconds) / 29 + 1.7);
  const envelope =
    1 -
    (0.04 + 0.64 * Math.max(0, Math.min(1, speed / 12))) * (0.5 - 0.5 * pulse);
  return envelope * (base * 2 - 1) * (0.25 + 0.75 * patch);
}

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
    expect(windWave(700, 900, 8, changed) / gustEnvelope(8, 10)).toBeCloseTo(
      windWave(700, 900, 8, { ...changed, speed: 3 }) / gustEnvelope(8, 3),
      12,
    );
    expect(advance(TRAVEL_WRAP - 1, 0.2, 12)).toBeLessThan(waveSpeed(12));
    expect(advance(0, 1000, 12)).toBeLessThan(waveSpeed(12));
  });

  it("keeps the CPU and shader lattice and field formulas in parity", () => {
    for (const x of [0, 123, 723, 1919])
      for (const y of [650, 840, 1080]) {
        for (const t of [0, 4.3, 28.7]) {
          const wind = { speed: 12, windX: -8, travel: t * 179 };
          expect(windWave(x, y, t, wind)).toBeCloseTo(
            shaderField(x, y, t, wind.speed, wind.windX, wind.travel),
            10,
          );
        }
      }
    // The shader is intentionally a direct transcription. Check every coefficient
    // and operation that controls noise sampling, evolution, and gust depth.
    for (const fragment of [
      "mod(mod(p, 128.0) + 128.0, 128.0)",
      "1664525u",
      "1013904223u",
      "2246822519u",
      "65535u",
      "f * f * (3.0 - 2.0 * f)",
      "0.6 + 0.4",
      "650.0) / 430.0",
      "0.72 * windNoise",
      "0.28 * windNoise",
      "travel * 0.75",
      "travel / 2000.0",
      "travel * 1.5",
      "0.25 + 0.75 * gustPatch",
      "q.y / 160.0",
      "q.y / 80.0",
      "q.y / 320.0",
      "0.04 + 0.64",
      "11.0",
      "17.0",
      "29.0",
    ])
      expect(WIND_GLSL).toContain(fragment);
  });
});
