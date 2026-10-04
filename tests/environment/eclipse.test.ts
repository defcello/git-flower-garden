import { describe, expect, it } from "vitest";
import {
  Observer,
  SearchLocalSolarEclipse,
  SearchLunarEclipse,
} from "#astronomy-engine";
import { discOverlap, lightingState } from "../../src/environment/lighting.ts";
import {
  PREVIEWS,
  previewSnapshot,
  type PreviewName,
} from "../../src/environment/overrides.ts";
import { moonShadow, skyBodies, transform } from "../../src/ui/scene/view.ts";

const state = (name: PreviewName) => lightingState(previewSnapshot(name));
const bodies = (name: PreviewName) =>
  skyBodies(transform(1920, 1080), state(name));

describe("disc overlap", () => {
  it("is none apart, all inside, and a lens between", () => {
    expect(discOverlap(1, 1, 2)).toBe(0);
    expect(discOverlap(1, 1.1, 0.05)).toBe(1);
    expect(discOverlap(1, 0.5, 0)).toBeCloseTo(0.25, 9);
    // Two unit discs a radius apart share about 39% of each.
    expect(discOverlap(1, 1, 1)).toBeCloseTo(0.391, 3);
  });
});

describe("solar eclipses", () => {
  it("the previews cover the Sun as far as the library finds", () => {
    for (const name of [
      "solar-eclipse-partial",
      "solar-eclipse-annular",
      "solar-eclipse-total",
    ] as const) {
      const { place, time } = PREVIEWS[name];
      const found = SearchLocalSolarEclipse(
        new Date(Date.parse(time) - 86_400_000),
        new Observer(
          place.latitude,
          place.longitude,
          place.elevationMeters ?? 0,
        ),
      );
      expect(found.kind, name).toBe(name.replace("solar-eclipse-", ""));
      expect(state(name).eclipse.solar, name).toBeCloseTo(found.obscuration, 2);
    }
  });

  it("dims the day, and only totality brings the corona and stars", () => {
    const partial = state("solar-eclipse-partial");
    const annular = state("solar-eclipse-annular");
    const total = state("solar-eclipse-total");
    const noon = state("noon");
    expect(noon.eclipse.solar).toBe(0);
    expect(noon.sun.intensity).toBe(1);
    for (const s of [partial, annular]) {
      expect(s.sun.intensity).toBeGreaterThan(0.3);
      expect(s.sun.intensity).toBeLessThan(0.8);
      expect(s.eclipse.corona).toBe(0);
      expect(s.stars).toBe(0);
    }
    expect(total.eclipse.corona).toBe(1);
    expect(total.sun.intensity).toBe(0);
    expect(total.stars).toBeGreaterThan(0);
    // A twilight sky at midday.
    expect(Math.max(...total.sky.zenith)).toBeLessThan(
      Math.max(...noon.sky.zenith) / 2,
    );
  });

  it("draws the Moon over the Sun at the discs' own scale", () => {
    for (const name of [
      "solar-eclipse-partial",
      "solar-eclipse-annular",
      "solar-eclipse-total",
    ] as const) {
      const s = state(name);
      const { sun, moon } = bodies(name);
      if (sun === null || moon === null) throw new Error(name);
      expect(sun.hole, name).toEqual({ x: moon.x, y: moon.y, r: moon.r });
      // The drawn discs overlap as far as the true ones.
      const drawn = discOverlap(
        sun.r,
        moon.r,
        Math.hypot(moon.x - sun.x, moon.y - sun.y),
      );
      expect(drawn, name).toBeCloseTo(s.eclipse.solar, 2);
    }
    // An annular eclipse leaves a ring; a total one covers the Sun.
    const annular = bodies("solar-eclipse-annular");
    expect(annular.moon?.r).toBeLessThan(annular.sun?.r ?? 0);
    const total = bodies("solar-eclipse-total");
    expect(total.moon?.r).toBeGreaterThan(total.sun?.r ?? Infinity);
  });

  it("never draws the Moon over the Sun when they are apart", () => {
    const { sun, moon } = bodies("new-moon");
    if (sun === null || moon === null) throw new Error("new-moon");
    expect(sun.hole).toBeNull();
    expect(Math.hypot(moon.x - sun.x, moon.y - sun.y)).toBeGreaterThanOrEqual(
      sun.r + moon.r - 1e-9,
    );
  });
});

describe("lunar eclipses", () => {
  it("the previews are in the library's eclipse, partial then total", () => {
    const found = SearchLunarEclipse(new Date("2025-03-13T00:00Z"));
    expect(found.kind).toBe("total");
    const partial = state("lunar-eclipse-partial");
    const total = state("lunar-eclipse-total");
    expect(partial.moon.aboveHorizon).toBe(true);
    expect(total.moon.aboveHorizon).toBe(true);
    expect(partial.eclipse.umbra).toBeGreaterThan(0.3);
    expect(partial.eclipse.umbra).toBeLessThan(0.9);
    expect(total.eclipse.umbra).toBe(1);
    expect(
      Math.abs(
        Date.parse(PREVIEWS["lunar-eclipse-total"].time) -
          found.peak.date.getTime(),
      ),
    ).toBeLessThan(60_000);
    // The full Moon lights the night far less in the umbra.
    const full = state("full-moon");
    expect(total.moon.intensity).toBeLessThan(full.moon.intensity / 5);
    expect(full.eclipse.umbra).toBe(0);
  });

  it("shades the disc red in the umbra, away from the Sun", () => {
    const moon = bodies("lunar-eclipse-partial").moon;
    if (moon === null) throw new Error("no Moon");
    const [cx, cy] = moon.shadow;
    const toward = Math.hypot(cx, cy);
    // The limb nearest the shadow's centre is in the umbra; the far one not.
    const near = moonShadow(
      (0.9 * cx) / toward,
      (0.9 * cy) / toward,
      moon.shadow,
    );
    const far = moonShadow(
      (-0.9 * cx) / toward,
      (-0.9 * cy) / toward,
      moon.shadow,
    );
    expect(near.umbra).toBeGreaterThan(0.9);
    expect(far.umbra).toBeLessThan(0.1);
    expect(far.dim).toBeGreaterThan(0);
    // No shadow on an ordinary full Moon.
    expect(bodies("full-moon").moon?.shadow).toEqual([0, 0, 0, 0]);
  });
});
