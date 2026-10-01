import { describe, expect, it } from "vitest";
import {
  Body,
  Observer,
  SearchHourAngle,
  SearchRiseSet,
} from "#astronomy-engine";
import {
  createEnvironment,
  environmentSnapshot,
} from "../../src/environment/environment.ts";
import {
  lightingState,
  project,
  twilightFor,
} from "../../src/environment/lighting.ts";
import {
  PREVIEW_NAMES,
  isPreviewName,
  previewSnapshot,
} from "../../src/environment/overrides.ts";

const blueRidge = { latitude: 35.5951, longitude: -82.5515 };
const sydney = { latitude: -33.8688, longitude: 151.2093 };

function sunEvents(
  place: { latitude: number; longitude: number },
  day: string,
) {
  const observer = new Observer(place.latitude, place.longitude, 0);
  const start = new Date(day);
  const event = (direction: number) => {
    const found = SearchRiseSet(Body.Sun, observer, direction, start, 1);
    if (found === null)
      throw new Error(`no sun event ${String(direction)} on ${day}`);
    return found.date;
  };
  return {
    rise: event(1),
    noon: SearchHourAngle(Body.Sun, observer, 0, start).time.date,
    set: event(-1),
  };
}

const at = (time: Date, place = blueRidge, zone = "America/New_York") =>
  lightingState(environmentSnapshot(time, place, zone));

describe("panoramic projection", () => {
  it.each([
    [
      "north of the equator",
      blueRidge,
      "2024-06-20T04:00Z",
      "America/New_York",
    ],
    ["south of the equator", sydney, "2024-06-20T14:00Z", "Australia/Sydney"],
  ])(
    "puts sunrise at the left, noon in the middle, sunset at the right %s",
    (_, place, day, zone) => {
      const { rise, noon, set } = sunEvents(place, day);
      expect(at(rise, place, zone).sun.u).toBeLessThan(0.25);
      expect(at(noon, place, zone).sun.u).toBeCloseTo(0.5, 2);
      expect(at(set, place, zone).sun.u).toBeGreaterThan(0.75);
      expect(at(rise, place, zone).rising).toBe(true);
      expect(at(set, place, zone).rising).toBe(false);
    },
  );

  it.each([
    ["the Moon, rising north of east", Body.Moon, "2024-12-15T18:00Z"],
    ["the midsummer Sun", Body.Sun, "2024-06-20T09:00Z"],
    ["the midwinter Sun", Body.Sun, "2024-12-21T11:00Z"],
  ])(
    "moves %s only left to right while it is up, and stays on screen",
    (_, body, day) => {
      const start = Date.parse(day);
      let previous = -1;
      let seen = 0;
      for (let minute = 0; minute <= 26 * 60; minute += 5) {
        const time = new Date(start + minute * 60_000);
        const state = at(time);
        const position = body === Body.Sun ? state.sun : state.moon;
        if (position.altitude <= 0) {
          if (seen > 0) break; // set: the visible arc is done
          continue;
        }
        if (seen++ === 0 && body === Body.Moon)
          expect(position.azimuth).toBeLessThan(90);
        expect(position.u).toBeGreaterThan(previous);
        expect(position.u).toBeGreaterThan(0);
        expect(position.u).toBeLessThan(1);
        previous = position.u;
      }
      expect(seen).toBeGreaterThan(50);
    },
  );

  it("squeezes the edges: east, the meridian, and west at 0.15, 0.5, 0.85", () => {
    const u = (azimuth: number) => project({ altitude: 0, azimuth }, 40).u;
    expect(u(90)).toBeCloseTo(0.5 - 0.5 * Math.SQRT1_2, 2);
    expect(project({ altitude: 30, azimuth: 180 }, 40).u).toBeCloseTo(0.5, 6);
    expect(u(270)).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 2);
    // North of east is further left, not folded back toward the middle.
    expect(u(60)).toBeLessThan(u(90));
    expect(project({ altitude: 10, azimuth: 0 }, 40).behind).toBe(true);
  });

  it("keeps the light direction physical: a south noon Sun backlights the scene", () => {
    const { direction } = project({ altitude: 30, azimuth: 180 }, 40);
    expect(direction.x).toBeCloseTo(0);
    expect(direction.y).toBeCloseTo(0.5);
    expect(direction.z).toBeLessThan(0);
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1);
  });
});

describe("lighting state", () => {
  it("classifies twilight by Sun altitude", () => {
    expect(twilightFor(5)).toBe("day");
    expect(twilightFor(-3)).toBe("civil");
    expect(twilightFor(-9)).toBe("nautical");
    expect(twilightFor(-15)).toBe("astronomical");
    expect(twilightFor(-30)).toBe("night");
  });

  it("shows stars at night and not at noon, with shadows only in sunlight", () => {
    const noon = lightingState(previewSnapshot("noon"));
    const night = lightingState(previewSnapshot("night"));
    expect(noon.stars).toBe(0);
    expect(night.stars).toBe(1);
    expect(noon.shadow).not.toBeNull();
    expect(noon.shadow?.length).toBeLessThan(0.5);
    expect(night.shadow).toBeNull();
    expect(night.sun.intensity).toBe(0);
  });

  it("casts long shadows away from a low Sun", () => {
    const sunrise = lightingState(previewSnapshot("sunrise"));
    expect(sunrise.shadow?.length).toBeGreaterThan(10 / 4);
    // The Sun rises on the left, so shadows fall to the right.
    expect(sunrise.shadow?.x).toBeGreaterThan(0);
  });

  it("changes smoothly minute by minute, through a daylight-saving change", () => {
    // New York springs forward at 2024-03-10T07:00Z; lighting must not jump.
    const start = Date.parse("2024-03-10T05:00Z");
    let previous = at(new Date(start));
    for (let minute = 1; minute <= 12 * 60; minute++) {
      const next = at(new Date(start + minute * 60_000));
      if (next.sun.aboveHorizon)
        expect(Math.abs(next.sun.u - previous.sun.u)).toBeLessThan(0.01);
      expect(Math.abs(next.stars - previous.stars)).toBeLessThan(0.05);
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs((next.sky.horizon[c] ?? 0) - (previous.sky.horizon[c] ?? 0)),
        ).toBeLessThan(0.05);
      previous = next;
    }
  });

  it("depends only on the instant, so a clock jump lands on the right sky", () => {
    let now = new Date("2024-06-20T17:32Z");
    const environment = createEnvironment({
      place: blueRidge,
      timeZone: "America/New_York",
      clock: () => now,
    });
    const before = environment.snapshot();
    now = new Date("2024-06-21T05:00Z"); // e.g. resumed from sleep
    const after = environment.snapshot();
    expect(lightingState(before).twilight).toBe("day");
    expect(lightingState(after)).toEqual(
      lightingState(environmentSnapshot(now, blueRidge, "America/New_York")),
    );
    expect(lightingState(after).twilight).not.toBe("day");
  });

  it("is stable: the same snapshot gives the same state", () => {
    const snapshot = previewSnapshot("sunset");
    expect(lightingState(snapshot)).toEqual(lightingState(snapshot));
  });

  it("shows local time in the configured zone, across the DST change", () => {
    const zone = "America/New_York";
    expect(
      environmentSnapshot(new Date("2024-03-10T06:30Z"), blueRidge, zone)
        .localTime,
    ).toContain("01:30 EST");
    expect(
      environmentSnapshot(new Date("2024-03-10T07:30Z"), blueRidge, zone)
        .localTime,
    ).toContain("03:30 EDT");
  });

  it("rejects an unknown time zone or place before computing", () => {
    expect(() =>
      createEnvironment({ place: blueRidge, timeZone: "Mars/Olympus" }),
    ).toThrow(RangeError);
    expect(() =>
      createEnvironment({
        place: { latitude: 91, longitude: 0 },
        timeZone: "UTC",
      }),
    ).toThrow(RangeError);
  });
});

describe("the Moon", () => {
  it("lights the limb that faces the Sun, whatever the phase", () => {
    // Waxing gibbous at dusk-ish, Sun set in the west: lit limb to the right.
    const firstQuarter = lightingState(previewSnapshot("first-quarter"));
    expect(
      Math.cos(firstQuarter.moon.limbAngle * (Math.PI / 180)),
    ).toBeGreaterThan(0.5);
    // Waning, before dawn, Sun below the eastern horizon: lit limb to the left.
    const lastQuarter = lightingState(previewSnapshot("last-quarter"));
    expect(Math.cos(lastQuarter.moon.limbAngle * (Math.PI / 180))).toBeLessThan(
      -0.5,
    );
    expect(firstQuarter.moon.waxing).toBe(true);
    expect(lastQuarter.moon.waxing).toBe(false);
  });

  it("can be up in daylight and still be drawn", () => {
    const state = lightingState(previewSnapshot("daytime-moon"));
    expect(state.sun.aboveHorizon).toBe(true);
    expect(state.moon.aboveHorizon).toBe(true);
    expect(state.twilight).toBe("day");
    // It casts no meaningful light by day, but its position is kept.
    expect(state.moon.intensity).toBeLessThan(0.01);
  });

  it("lights a full-moon night more than a moonless one", () => {
    const full = lightingState(previewSnapshot("full-moon"));
    const moonless = lightingState(previewSnapshot("night"));
    expect(full.moon.intensity).toBeGreaterThan(0.1);
    expect(moonless.moon.intensity).toBe(0);
  });
});

describe("developer previews", () => {
  const sky = (name: (typeof PREVIEW_NAMES)[number]) => {
    const snapshot = previewSnapshot(name);
    return { snapshot, state: lightingState(snapshot) };
  };

  it("are marked as previews, never as live", () => {
    for (const name of PREVIEW_NAMES) {
      const { snapshot } = sky(name);
      expect(snapshot.source).toBe("preview");
      expect(snapshot.preview).toBe(name);
    }
    expect(isPreviewName("noon")).toBe(true);
    expect(isPreviewName("toString")).toBe(false);
  });

  it("each show the condition they are named for", () => {
    const sunrise = sky("sunrise").state;
    expect(sunrise.sun.altitude).toBeGreaterThan(0);
    expect(sunrise.sun.altitude).toBeLessThan(5);
    expect(sunrise.rising).toBe(true);

    const noon = sky("noon").state;
    expect(noon.sun.altitude).toBeGreaterThan(70);
    expect(noon.sun.u).toBeCloseTo(0.5, 2);

    const sunset = sky("sunset").state;
    expect(sunset.sun.altitude).toBeGreaterThan(0);
    expect(sunset.sun.altitude).toBeLessThan(5);
    expect(sunset.rising).toBe(false);

    expect(sky("civil-dusk").state.twilight).toBe("civil");

    const night = sky("night").state;
    expect(night.twilight).toBe("night");
    expect(night.moon.aboveHorizon).toBe(false);

    const phases = [
      ["new-moon", 0],
      ["first-quarter", 90],
      ["full-moon", 180],
      ["last-quarter", 270],
    ] as const;
    for (const [name, degrees] of phases) {
      const { moon } = sky(name).state;
      const off = Math.abs(((moon.phaseDegrees - degrees + 540) % 360) - 180);
      expect(off, name).toBeLessThan(10);
      expect(moon.aboveHorizon, name).toBe(true);
    }
    expect(sky("full-moon").state.twilight).toBe("night");

    const polarDay = sky("polar-day");
    expect(polarDay.snapshot.localTime).toContain("00:00");
    expect(polarDay.state.sun.aboveHorizon).toBe(true);
    // The midnight Sun is behind the viewer.
    expect(polarDay.state.sun.behind).toBe(true);

    const polarNight = sky("polar-night");
    expect(polarNight.snapshot.localTime).toContain("12:00");
    expect(polarNight.state.sun.aboveHorizon).toBe(false);
    expect(polarNight.state.twilight).toBe("nautical");
  });

  it("the polar previews really are polar day and night", () => {
    const observer = new Observer(78.2232, 15.6267, 10);
    expect(
      SearchRiseSet(Body.Sun, observer, -1, new Date("2024-06-20T12:00Z"), 1),
    ).toBeNull();
    expect(
      SearchRiseSet(Body.Sun, observer, 1, new Date("2024-12-20T12:00Z"), 1),
    ).toBeNull();
  });
});
