import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Body,
  Observer,
  SearchMoonPhase,
  SearchRiseSet,
  Seasons,
} from "#astronomy-engine";
import { skyBodies } from "../../src/environment/astronomy.ts";

const vendor = join(import.meta.dirname, "../../vendor/astronomy-engine");

/** Minutes between two instants. */
const minutes = (a: Date, b: string) =>
  Math.abs(a.getTime() - Date.parse(b)) / 60_000;

describe("vendored astronomy-engine", () => {
  // The files reviewed in ADR 0019. Moving the submodule without a new review
  // fails here: update the review, then these hashes.
  it.each([
    [
      "source/js/esm/astronomy.js",
      "068f1445ed0c636c94818fe6d20d7d125120e605e0bab9fc4675c3d531be5ad7",
    ],
    [
      "source/js/astronomy.d.ts",
      "fc5f1ede68dbebc32ce2f3f878cb3b261dc1bf8c16422451f0c4092c41fc871e",
    ],
    [
      "source/js/astronomy.ts",
      "e043bba40da82c981d2952407c68975b60cd9d94675c91e1c0d3c8c148595fb3",
    ],
    [
      "LICENSE",
      "690dd98cb13ba4db77c6327deea852a816892bb9debbad5943405c66972f8023",
    ],
  ])("%s is the reviewed file", (file, sha256) => {
    const bytes = readFileSync(join(vendor, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  });

  // Published instants (U.S. Naval Observatory), to within two minutes.
  it("finds the 2024 equinox and solstice", () => {
    const seasons = Seasons(2024);
    expect(minutes(seasons.mar_equinox.date, "2024-03-20T03:06Z")).toBeLessThan(
      2,
    );
    expect(
      minutes(seasons.jun_solstice.date, "2024-06-20T20:51Z"),
    ).toBeLessThan(2);
  });

  it("finds a new and a full moon", () => {
    const newMoon = SearchMoonPhase(0, new Date("2024-04-01T00:00Z"), 30);
    const fullMoon = SearchMoonPhase(180, new Date("2024-01-20T00:00Z"), 30);
    expect(newMoon && minutes(newMoon.date, "2024-04-08T18:21Z")).toBeLessThan(
      2,
    );
    expect(
      fullMoon && minutes(fullMoon.date, "2024-01-25T17:54Z"),
    ).toBeLessThan(2);
  });

  it("finds no sunset during polar day", () => {
    const longyearbyen = new Observer(78.22, 15.65, 0);
    expect(
      SearchRiseSet(
        Body.Sun,
        longyearbyen,
        -1,
        new Date("2024-06-15T00:00Z"),
        1,
      ),
    ).toBeNull();
  });
});

describe("skyBodies", () => {
  it("puts the solstice sun at the axial tilt above the North Pole", () => {
    const { sun } = skyBodies(new Date("2024-06-20T20:51Z"), {
      latitude: 90,
      longitude: 0,
    });
    // 23.44° plus under 0.05° of refraction.
    expect(sun.altitude).toBeGreaterThan(23.4);
    expect(sun.altitude).toBeLessThan(23.5);
  });

  it("puts the equinox sun nearly overhead at noon on the equator", () => {
    // Solar noon at longitude 0 is about 12:07 UTC in late March.
    const { sun } = skyBodies(new Date("2024-03-20T12:07Z"), {
      latitude: 0,
      longitude: 0,
    });
    expect(sun.altitude).toBeGreaterThan(89);
  });

  it("gives the Moon's phase and lit fraction", () => {
    const place = { latitude: 35.6, longitude: -82.55 }; // Asheville, NC
    const dark = skyBodies(new Date("2024-04-08T18:21Z"), place).moon;
    const full = skyBodies(new Date("2024-01-25T17:54Z"), place).moon;
    expect(dark.illuminatedFraction).toBeLessThan(0.01);
    expect(Math.min(dark.phaseDegrees, 360 - dark.phaseDegrees)).toBeLessThan(
      0.5,
    );
    expect(full.illuminatedFraction).toBeGreaterThan(0.99);
    expect(Math.abs(full.phaseDegrees - 180)).toBeLessThan(0.5);
  });

  it("measures azimuth clockwise from north", () => {
    // Morning sun is in the east, evening sun in the west (Asheville, local noon ~17:30 UTC).
    const place = { latitude: 35.6, longitude: -82.55 };
    const morning = skyBodies(new Date("2024-06-20T13:00Z"), place).sun;
    const evening = skyBodies(new Date("2024-06-20T22:00Z"), place).sun;
    expect(morning.azimuth).toBeGreaterThan(45);
    expect(morning.azimuth).toBeLessThan(135);
    expect(evening.azimuth).toBeGreaterThan(225);
    expect(evening.azimuth).toBeLessThan(315);
  });

  it("rejects invalid input with an Error before calling the library", () => {
    const at = new Date("2024-06-20T12:00Z");
    expect(() =>
      skyBodies(new Date(Number.NaN), { latitude: 0, longitude: 0 }),
    ).toThrow(RangeError);
    expect(() => skyBodies(at, { latitude: Number.NaN, longitude: 0 })).toThrow(
      RangeError,
    );
    expect(() => skyBodies(at, { latitude: 91, longitude: 0 })).toThrow(
      RangeError,
    );
    expect(() => skyBodies(at, { latitude: 0, longitude: 181 })).toThrow(
      RangeError,
    );
    expect(() =>
      skyBodies(at, {
        latitude: 0,
        longitude: 0,
        elevationMeters: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(RangeError);
  });
});
