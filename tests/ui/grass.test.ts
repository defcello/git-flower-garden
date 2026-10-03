import { describe, expect, it } from "vitest";
import { CREST } from "../../src/ui/scene/crest.ts";
import {
  BEND_MAX,
  BEND_MIN,
  crestAt,
  grassField,
  gustBend,
  steadyBend,
  tuftBend,
  tuftPose,
  tuftSize,
  tuftSpacing,
  type Tuft,
} from "../../src/ui/scene/grass.ts";
import { DESIGN } from "../../src/ui/scene/view.ts";
import { PRESETS } from "../../src/ui/scene/quality.ts";
import { WAVELENGTH, waveSpeed } from "../../src/ui/scene/wind-field.ts";

const wind = (speed: number, windX: number, travel = 0, gust?: number) => ({
  ...(gust === undefined ? {} : { gust }),
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
    // The budget measured on the Surface Pro (ADR 0021, third iteration):
    // about 9,000 tufts at Balanced.
    expect(grassField(PRESETS.balanced.grass.gpu).length).toBeLessThan(9500);
    // Software's, filled on the CPU without a GPU: about 4,000.
    expect(grassField(PRESETS.balanced.grass.software).length).toBeLessThan(
      4500,
    );
  });

  it("grows closer together toward the viewer, so the near hill has no bare spots", () => {
    expect(tuftSpacing(0)).toBeGreaterThan(tuftSpacing(0.5));
    expect(tuftSpacing(0.5)).toBeGreaterThan(tuftSpacing(1));
    // The share of the ground the tufts' rectangles cover, per band.
    const tufts = grassField(PRESETS.balanced.grass.gpu);
    const cover = (top: number, bottom: number) =>
      tufts
        .filter((t) => t.y >= top && t.y < bottom)
        .reduce((sum, t) => sum + t.size * t.size * t.stretch, 0) /
      ((bottom - top) * DESIGN.width);
    expect(cover(1000, 1080)).toBeGreaterThan(cover(700, 780) * 1.5);
  });

  it("gives each tuft its own size, height, stiffness, and delay", () => {
    const tufts = grassField(1);
    const range = (pick: (t: Tuft) => number) => {
      const values = tufts.map(pick);
      return [Math.min(...values), Math.max(...values)];
    };
    expect(range((t) => t.stretch)).toEqual([
      expect.closeTo(0.85, 1),
      expect.closeTo(1.2, 1),
    ]);
    expect(range((t) => t.stiff)).toEqual([
      expect.closeTo(0.8, 1),
      expect.closeTo(1.2, 1),
    ]);
    expect(range((t) => t.delay)).toEqual([
      expect.closeTo(0, 1),
      expect.closeTo(0.15, 1),
    ]);
    // Neighbors in a row differ in size by up to about a half.
    const ratios = tufts.slice(1, 400).map((t, i) => {
      const before = tufts[i]?.size ?? t.size;
      return Math.max(t.size, before) / Math.min(t.size, before);
    });
    expect(Math.max(...ratios)).toBeGreaterThan(1.4);
  });

  it("bends downwind, further in stronger wind, within bounds", () => {
    const tuft = grassField(1)[500];
    if (!tuft) throw new Error("no tuft");
    const pose = (speed: number, seconds: number | null, gust?: number) =>
      tuftPose(tuft, seconds, wind(speed, speed, 0, gust));
    // At rest, the wind's steady push, more in stronger wind.
    expect(pose(0, null).bend).toBe(0);
    expect(pose(2, null).bend).toBeGreaterThan(0);
    expect(pose(12, null).bend).toBeGreaterThan(pose(2, null).bend);
    // A hurricane lays it over, but never flat.
    expect(steadyBend(70)).toBeGreaterThan(1);
    expect(steadyBend(70)).toBeLessThan(BEND_MAX);
    // Still air: still grass.
    for (let s = 0; s < 20; s += 0.5) expect(pose(0, s, 0).bend).toBe(0);
    // Over a minute, on average about its steady bend, always in bounds.
    for (const speed of [4, 12, 70]) {
      let sum = 0;
      let n = 0;
      for (let s = 0; s < 60; s += 0.25) {
        const bend = tuftPose(
          tuft,
          s,
          wind(speed, -speed, s * waveSpeed(speed)),
        ).bend;
        expect(bend).toBeGreaterThanOrEqual(BEND_MIN);
        expect(bend).toBeLessThanOrEqual(BEND_MAX);
        sum += bend;
        n++;
      }
      expect(sum / n).toBeCloseTo(steadyBend(speed), 0);
    }
  });

  it("swings further in stronger gusts", () => {
    const tufts = grassField(1).slice(0, 400);
    const swing = (gust: number) => {
      let most = 0;
      for (const tuft of tufts) {
        const at = (s: number) =>
          tuftPose(tuft, s, wind(10, 10, s * 100, gust)).bend;
        most = Math.max(most, Math.abs(at(3) - at(0)));
      }
      return most;
    };
    expect(swing(0)).toBeLessThan(0.1);
    expect(swing(3)).toBeGreaterThan(swing(0) * 2);
    expect(swing(15)).toBeGreaterThan(swing(3) * 1.5);
    expect(gustBend(0)).toBe(0);
  });

  it("moves with its neighbors, in waves rolling across the hill", () => {
    // Bend over a minute of a gale, for a tuft at (x, y).
    const series = (x: number, delay = 0, y = 1000, windZ = 0) => {
      const tuft: Tuft = {
        x,
        y,
        size: 60,
        kind: 1,
        flip: false,
        seed: 0.37,
        stretch: 1,
        stiff: 1,
        delay,
      };
      return Array.from({ length: 240 }, (_, i) => {
        const s = i * 0.25;
        const speed = windZ === 0 ? 14 : 0;
        return tuftPose(tuft, s, {
          ...wind(14, speed, s * waveSpeed(14)),
          windZ,
        }).bend;
      });
    };
    const here = series(600);
    // Neighbors a tuft's width apart bend almost as one, and still mostly
    // together when one answers the gusts as late as any; tufts half a wave
    // apart do not.
    expect(correlation(here, series(615))).toBeGreaterThan(0.9);
    expect(correlation(here, series(615, 0.15))).toBeGreaterThan(0.5);
    expect(correlation(here, series(600 + WAVELENGTH / 2))).toBeLessThan(0.5);
    // The wave travels downwind: a tuft downwind bends as this one did a
    // moment before.
    const later = series(700);
    const lagged = (lag: number, a: number[], b: number[]) =>
      correlation(a.slice(0, 240 - lag), b.slice(lag));
    expect(lagged(2, here, later)).toBeGreaterThan(lagged(0, here, later));
    // A tuft answering late bends as it would have a moment before.
    const late = series(600, 0.25);
    expect(lagged(1, here, late)).toBeGreaterThan(0.99);
    expect(lagged(1, here, late)).toBeGreaterThan(lagged(0, here, late));
    // A wind into the scene rolls its waves up the hill.
    const near = series(600, 0, 1040, 14);
    const far = series(600, 0, 1000, 14);
    expect(lagged(2, near, far)).toBeGreaterThan(lagged(0, near, far));
  });

  it("lights bent grass and shades upright grass only while it moves", () => {
    const tuft = grassField(1)[800];
    if (!tuft) throw new Error("no tuft");
    const pose = (seconds: number | null) =>
      tuftPose(tuft, seconds, wind(12, 12, (seconds ?? 0) * 150));
    expect(pose(null).lift).toBe(0);
    const steady = pose(null).bend;
    let lifted = 0;
    for (let s = 0; s < 60; s += 0.5) {
      const { bend, lift } = pose(s);
      expect(Math.abs(lift)).toBeLessThanOrEqual(1);
      // Bent further than its steady bend: paler; less: darker.
      if (Math.abs(lift) > 0.2)
        expect(Math.sign(bend - steady)).toBe(Math.sign(lift));
      if (Math.abs(lift) > 0.2) lifted++;
    }
    expect(lifted).toBeGreaterThan(10);
  });

  it("bends blades along an arc that keeps their length", () => {
    const across = { x: 1, z: 0 };
    expect(tuftBend(0.7, 1, 0, across)).toEqual({ x: 0, up: 0.7 });
    for (const bend of [0.3, -0.6, 1.4]) {
      // The stem's length on screen, walked in small steps.
      let length = 0;
      let last = tuftBend(0, 1, bend, across);
      for (let i = 1; i <= 1000; i++) {
        const p = tuftBend(i / 1000, 1, bend, across);
        length += Math.hypot(p.x - last.x, p.up - last.up);
        last = p;
      }
      expect(length).toBeCloseTo(1, 4);
      // Its tip turns `bend` from upright, downwind.
      const tip = tuftBend(1, 1, bend, across);
      const before = tuftBend(0.999, 1, bend, across);
      expect(Math.atan2(tip.x - before.x, tip.up - before.up)).toBeCloseTo(
        bend,
        2,
      );
      expect(Math.sign(tuftBend(1, 1, bend, { x: -1, z: 0 }).x)).toBe(
        -Math.sign(bend),
      );
    }
    // Bent into the scene, a tuft looks shorter, its tip a little higher
    // than bent toward the viewer.
    const away = tuftBend(1, 1, 1, { x: 0, z: 1 });
    const toward = tuftBend(1, 1, 1, { x: 0, z: -1 });
    expect(away.x).toBeCloseTo(0, 12);
    expect(away.up).toBeLessThan(1);
    expect(away.up).toBeGreaterThan(toward.up);
  });
});

function correlation(a: number[], b: number[]): number {
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
}
