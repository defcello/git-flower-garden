import { describe, expect, it } from "vitest";
import { environmentSnapshot } from "../../src/environment/environment.ts";
import { lightingState } from "../../src/environment/lighting.ts";
import { previewSnapshot } from "../../src/environment/overrides.ts";
import { PREVIEWS } from "../../src/environment/overrides.ts";
import {
  bowAngle,
  exitAngle,
  rainbowAt,
  rainbowProfile,
  waterIndex,
  wavelengthRgb,
} from "../../src/environment/rainbow.ts";
import {
  rainbow,
  weatherEffects,
} from "../../src/environment/weather-effects.ts";
import { previewConditions } from "../../src/environment/weather-previews.ts";
import {
  PIXELS_PER_DEGREE,
  RAINBOW_GROUND,
  RAINBOW_RADIUS,
  RAINBOW_SCALE,
  rainbowAngle,
  rainbowCentre,
  skyPlace,
  skyPoint,
} from "../../src/ui/scene/view.ts";

const luminance = (c: number[]) =>
  0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

/** Where a channel of the profile peaks, between two angles. */
function peak(channel: number, from: number, to: number): number {
  let best = -Infinity;
  let at = from;
  for (let theta = from; theta <= to; theta += 0.05) {
    const v = rainbowAt(theta)[channel] ?? 0;
    if (v > best) {
      best = v;
      at = theta;
    }
  }
  return at;
}

describe("rainbow optics", () => {
  it("disperses: water bends violet more than red", () => {
    expect(waterIndex(589.29)).toBeCloseTo(1.33299, 5);
    expect(waterIndex(405)).toBeGreaterThan(waterIndex(700));
  });

  it("puts the primary at about 42° with red outside, and the secondary at about 51° reversed", () => {
    const red = waterIndex(700);
    const violet = waterIndex(405);
    // Textbook values: primary 40.6° (violet) to 42.3° (red); secondary
    // 50.4° (red) to 53.6° (violet).
    expect(bowAngle(red, 1)).toBeCloseTo(42.5, 0);
    expect(bowAngle(violet, 1)).toBeCloseTo(40.6, 0);
    expect(bowAngle(red, 2)).toBeCloseTo(50.2, 0);
    expect(bowAngle(violet, 2)).toBeCloseTo(53.6, 0);
    // The bow is the extreme every ray approaches: no primary ray strays
    // outside it, no secondary ray inside.
    const n = waterIndex(550);
    for (let b = 0.01; b < 1; b += 0.01) {
      expect(exitAngle(Math.asin(b), n, 1)).toBeLessThanOrEqual(
        bowAngle(n, 1) + 1e-9,
      );
      expect(exitAngle(Math.asin(b), n, 2)).toBeGreaterThanOrEqual(
        bowAngle(n, 2) - 1e-9,
      );
    }
  });

  it("matches colours to wavelengths", () => {
    const [r, g, b] = wavelengthRgb(650);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    const [, g2] = wavelengthRgb(530);
    expect(g2).toBeGreaterThan(wavelengthRgb(530)[0]);
    expect(wavelengthRgb(450)[2]).toBeGreaterThan(wavelengthRgb(450)[0]);
  });

  it("shows both bows, the dark band, and the bright sky inside", () => {
    const profile = rainbowProfile();
    expect(rainbowProfile()).toBe(profile); // computed once
    // Primary: red peaks outside blue.
    const primaryRed = peak(0, 38, 45);
    const primaryBlue = peak(2, 38, 45);
    expect(primaryRed).toBeGreaterThan(41.5);
    expect(primaryRed).toBeLessThan(42.7);
    expect(primaryBlue).toBeLessThan(primaryRed);
    // Secondary: reversed, red inside blue.
    const secondaryRed = peak(0, 48, 56);
    const secondaryBlue = peak(2, 48, 56);
    expect(secondaryRed).toBeGreaterThan(50);
    expect(secondaryBlue).toBeGreaterThan(secondaryRed);
    // Brightness: the primary's peak is 1, the secondary is fainter.
    let primary = 0;
    for (let t = 38; t < 45; t += 0.05)
      primary = Math.max(primary, luminance(rainbowAt(t)));
    let secondary = 0;
    for (let t = 48; t < 56; t += 0.05)
      secondary = Math.max(secondary, luminance(rainbowAt(t)));
    expect(primary).toBeCloseTo(1, 2);
    expect(secondary).toBeGreaterThan(0.05);
    expect(secondary).toBeLessThan(0.4);
    // Alexander's dark band between them, darker than inside the primary.
    const band = luminance(rainbowAt(46.5));
    expect(band).toBeLessThan(0.01);
    expect(luminance(rainbowAt(35))).toBeGreaterThan(0.1);
    expect(luminance(rainbowAt(35))).toBeGreaterThan(luminance(rainbowAt(10)));
  });
});

describe("rainbow geometry", () => {
  it("centres opposite the Sun: its place mirrored, as far below the horizon", () => {
    for (const name of ["sunrise", "sunset"] as const) {
      const state = lightingState(previewSnapshot(name));
      const bow = rainbow(
        state,
        weatherEffects(previewConditions("showers", 0)),
      );
      if (!bow) throw new Error(`no rainbow at ${name}`);
      expect(bow.antisolar.u, name).toBeCloseTo(1 - state.sun.u, 9);
      expect(bow.antisolar.altitude, name).toBeCloseTo(-state.sun.altitude, 9);
    }
    // Morning bows are west (right), afternoon bows east (left).
    expect(
      lightingState(previewSnapshot("sunrise")).antisolar.u,
    ).toBeGreaterThan(0.5);
    expect(lightingState(previewSnapshot("sunset")).antisolar.u).toBeLessThan(
      0.5,
    );
  });

  it("moves smoothly through solar noon and sinks into the ground by 42°", () => {
    const { place, timeZone } = PREVIEWS.noon;
    // A showery October day in the Blue Ridge, a minute at a time from
    // 10:00 to 16:00 EDT: the Sun climbs past 42° and back.
    const start = Date.parse("2026-10-04T14:00Z");
    let before: { x: number; y: number } | null = null;
    for (let minute = 0; minute <= 360; minute++) {
      const state = lightingState(
        environmentSnapshot(new Date(start + minute * 60_000), place, timeZone),
      );
      const centre = rainbowCentre(state.antisolar);
      if (before) {
        // No jump from one edge to the other (it did at solar noon).
        expect(Math.abs(centre.x - before.x), String(minute)).toBeLessThan(5);
        expect(Math.abs(centre.y - before.y), String(minute)).toBeLessThan(5);
      }
      before = centre;
      // The primary's top is above the ground only while the Sun is below 42°.
      const top = centre.y - RAINBOW_RADIUS * RAINBOW_SCALE;
      if (state.sun.altitude > RAINBOW_RADIUS + 0.01)
        expect(top, String(minute)).toBeGreaterThan(RAINBOW_GROUND);
      if (state.sun.altitude < RAINBOW_RADIUS - 0.01)
        expect(top, String(minute)).toBeLessThan(RAINBOW_GROUND);
    }
  });

  it("is round, stands on the ground, and sinks as the Sun climbs", () => {
    for (const name of ["sunrise", "sunset", "daytime-moon"] as const) {
      const state = lightingState(previewSnapshot(name));
      const bow = rainbow(
        state,
        weatherEffects(previewConditions("showers", 0)),
      );
      if (!bow) throw new Error(`no rainbow at ${name}`);
      const centre = rainbowCentre(bow.antisolar);
      // Its lower half is never seen: the centre is on or below the ground
      // line, which the hill hides from edge to edge.
      expect(centre.y, name).toBeGreaterThanOrEqual(RAINBOW_GROUND);
      // Straight up, the primary's top is 42° less the Sun's altitude above
      // the ground line, on the bow's own scale.
      const top = {
        x: centre.x,
        y:
          RAINBOW_GROUND -
          (RAINBOW_RADIUS - state.sun.altitude) * RAINBOW_SCALE,
      };
      expect(rainbowAngle(top.x, top.y, centre), name).toBeCloseTo(
        RAINBOW_RADIUS,
        9,
      );
      // The same angle in every direction: a circle, not the oval the
      // panorama's wider azimuth scale would make.
      for (let turn = 0; turn < 360; turn += 30) {
        const a = (turn * Math.PI) / 180;
        const r = RAINBOW_RADIUS * RAINBOW_SCALE;
        expect(
          rainbowAngle(
            centre.x + r * Math.cos(a),
            centre.y + r * Math.sin(a),
            centre,
          ),
        ).toBeCloseTo(RAINBOW_RADIUS, 9);
      }
    }
    // With the Sun on the horizon, the top is at the true height.
    const level = rainbowCentre({ u: 0.5, altitude: 0 });
    expect(level.y - RAINBOW_RADIUS * RAINBOW_SCALE).toBeCloseTo(
      skyPlace({ u: 0.5, altitude: RAINBOW_RADIUS }).y,
      9,
    );
    // Larger than the sky's scale: the landscape is not at its true depth.
    expect(RAINBOW_SCALE / PIXELS_PER_DEGREE).toBeGreaterThan(2);
    // The ground line is behind the hill's whole crest.
    expect(RAINBOW_GROUND / 1080).toBeGreaterThanOrEqual(0.759);
    // Where the panorama puts sky bodies, skyPlace agrees.
    for (const altitude of [-5, 0, 30, 89])
      expect(skyPlace({ u: 0.3, altitude })).toEqual(
        skyPoint({ u: 0.3, altitude }),
      );
  });
});
