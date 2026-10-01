import { describe, expect, it } from "vitest";
import { lightingState } from "../../src/environment/lighting.ts";
import { previewSnapshot } from "../../src/environment/overrides.ts";
import {
  cloudColors,
  cloudField,
  hash01,
  NO_WEATHER,
  PARTICLE_CAPS,
  PARTICLE_LOOP_SECONDS,
  particleAt,
  particleField,
  rainbow,
  weatherEffects,
  weatherLighting,
  type WeatherEffects,
} from "../../src/environment/weather-effects.ts";
import {
  previewConditions,
  WEATHER_PREVIEW_NAMES,
  type WeatherPreviewName,
} from "../../src/environment/weather-previews.ts";

const NOON = lightingState(previewSnapshot("noon"));
const SUNSET = lightingState(previewSnapshot("sunset"));
const NIGHT = lightingState(previewSnapshot("full-moon"));
const preview = (name: WeatherPreviewName) =>
  weatherEffects(previewConditions(name, Date.parse("2024-06-20T17:00Z")));

describe("weather effects (ADR 0018 step 5)", () => {
  it("is neutral without conditions, and leaves the light untouched", () => {
    expect(weatherEffects(null)).toBe(NO_WEATHER);
    expect(weatherLighting(NOON, NO_WEATHER)).toBe(NOON);
  });

  it("reads every preview into the weather it names", () => {
    const all = Object.fromEntries(
      WEATHER_PREVIEW_NAMES.map((name) => [name, preview(name)]),
    ) as Record<WeatherPreviewName, WeatherEffects>;
    expect(all.clear.cloudCover).toBe(0);
    expect(all.clear.precipitation).toBeNull();
    expect(all.overcast.cloudCover).toBe(1);
    expect(all.fog.fog).toBe(1);
    expect(all["light-rain"].precipitation).toEqual({
      type: "rain",
      density: 0.3,
      showers: false,
    });
    expect(all["heavy-rain"].precipitation?.density).toBe(1);
    expect(all.showers.precipitation?.showers).toBe(true);
    expect(all.thunderstorm.thunder).toBe(true);
    expect(all.sleet.precipitation?.type).toBe("sleet");
    expect(all.snow.precipitation?.type).toBe("snow");
    expect(all["high-wind"].windSpeed).toBe(16);
    // Rain darkens the cloud more than a dry overcast.
    expect(all["heavy-rain"].cloudDarkness).toBeGreaterThan(
      all.overcast.cloudDarkness,
    );
  });

  it("puts cloud overhead whenever something falls", () => {
    const c = previewConditions("showers", 0);
    expect(
      weatherEffects({ ...c, cloudCover: 0.1 }).cloudCover,
    ).toBeGreaterThanOrEqual(0.6);
    expect(
      weatherEffects({
        ...c,
        cloudCover: 0.1,
        precipitation: { ...c.precipitation, showers: false },
      }).cloudCover,
    ).toBeGreaterThanOrEqual(0.85);
  });

  it("maps wind to the panorama: east is left, so a west wind blows left", () => {
    const c = previewConditions("high-wind", 0);
    const fromWest = weatherEffects(c);
    const fromEast = weatherEffects({
      ...c,
      wind: { ...c.wind, fromDegrees: 90 },
    });
    expect(fromWest.windX).toBeCloseTo(-16, 6);
    expect(fromEast.windX).toBeCloseTo(16, 6);
  });
});

describe("weather and light", () => {
  it("dims the Sun under cloud, keeps some light, and drops faint shadows", () => {
    const overcast = weatherLighting(NOON, preview("overcast"));
    expect(overcast.sun.intensity).toBeLessThan(NOON.sun.intensity * 0.3);
    expect(overcast.sun.intensity).toBeGreaterThan(0);
    expect(overcast.shadow).toBeNull();
    const partly = weatherLighting(NOON, preview("partly-cloudy"));
    expect(partly.sun.intensity).toBeGreaterThan(overcast.sun.intensity);
    expect(partly.shadow).not.toBeNull();
    // Sun and Moon keep their place in the sky.
    expect(overcast.sun.u).toBe(NOON.sun.u);
    expect(overcast.sun.altitude).toBe(NOON.sun.altitude);
  });

  it("greys the sky and hides the stars under overcast", () => {
    const spread = (c: readonly number[]) => Math.max(...c) - Math.min(...c);
    const overcast = weatherLighting(NOON, preview("overcast"));
    expect(spread(overcast.sky.zenith)).toBeLessThan(
      spread(NOON.sky.zenith) * 0.3,
    );
    expect(NIGHT.stars).toBeGreaterThan(0.9);
    expect(weatherLighting(NIGHT, preview("overcast")).stars).toBe(0);
    expect(
      weatherLighting(NIGHT, preview("partly-cloudy")).stars,
    ).toBeGreaterThan(0.2);
  });

  it("thickens the haze in fog and rain", () => {
    expect(weatherLighting(NOON, preview("fog")).haze).toBeGreaterThan(
      NOON.haze + 0.3,
    );
    expect(weatherLighting(NOON, preview("heavy-rain")).haze).toBeGreaterThan(
      NOON.haze,
    );
  });

  it("lights cloud tops brighter than their bases, darker in a storm", () => {
    const light = weatherLighting(NOON, preview("partly-cloudy"));
    const fair = cloudColors(light, preview("partly-cloudy"));
    expect(Math.min(...fair.top)).toBeGreaterThan(Math.max(...fair.base) - 0.1);
    const storm = cloudColors(
      weatherLighting(NOON, preview("thunderstorm")),
      preview("thunderstorm"),
    );
    expect(Math.max(...storm.base)).toBeLessThan(Math.max(...fair.base));
  });
});

describe("cloud field", () => {
  it("is stable, and more cover only adds clouds", () => {
    const some = { ...NO_WEATHER, cloudCover: 0.3 };
    const more = { ...NO_WEATHER, cloudCover: 0.7 };
    expect(cloudField(some, 100)).toEqual(cloudField(some, 100));
    const a = cloudField(some, 100).puffs;
    const b = cloudField(more, 100).puffs;
    expect(b.length).toBeGreaterThan(a.length);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(cloudField(NO_WEATHER, 100)).toEqual({ puffs: [], deck: 0 });
  });

  it("closes into a deck only as the sky becomes overcast", () => {
    expect(cloudField({ ...NO_WEATHER, cloudCover: 0.4 }, 0).deck).toBe(0);
    expect(cloudField({ ...NO_WEATHER, cloudCover: 1 }, 0).deck).toBe(1);
  });

  it("drifts downwind with the minutes, and stays in the sky", () => {
    const w = { ...NO_WEATHER, cloudCover: 0.5, windX: 4 };
    const now = cloudField(w, 0).puffs;
    const later = cloudField(w, 10).puffs;
    // 10 minutes of a 4 m/s wind: 100 design pixels (where nothing wrapped).
    const moved = later.map((p, i) => p.x - (now[i]?.x ?? 0));
    expect(
      moved.filter((d) => Math.abs(d - 100) < 1e-9).length,
    ).toBeGreaterThan(moved.length * 0.6);
    for (const p of now) expect(p.y).toBeLessThan(540);
    // Calm air: still clouds.
    expect(cloudField({ ...w, windX: 0 }, 10)).toEqual(
      cloudField({ ...w, windX: 0 }, 0),
    );
  });
});

describe("rainbow", () => {
  it("needs sunlit rain: the Sun up, liquid drops, and gaps in the cloud", () => {
    const showers = preview("showers");
    const low = weatherLighting(SUNSET, showers);
    const bow = rainbow(low, showers);
    expect(bow).not.toBeNull();
    // The bow circles the point opposite the Sun.
    expect(bow?.antisolar).toEqual({
      u: 1 - low.sun.u,
      altitude: -low.sun.altitude,
    });
    expect(rainbow(low, preview("snow"))).toBeNull();
    expect(rainbow(low, preview("sleet"))).toBeNull();
    expect(rainbow(low, preview("clear"))).toBeNull();
    // A full deck hides the Sun; night has none.
    expect(rainbow(low, preview("heavy-rain"))).toBeNull();
    expect(rainbow(weatherLighting(NIGHT, showers), showers)).toBeNull();
    // The noon Sun (78°) puts even the secondary bow far below the horizon.
    expect(rainbow(weatherLighting(NOON, showers), showers)).toBeNull();
  });

  it("is brighter through more gaps, and reddened by a low Sun", () => {
    const showers = preview("showers");
    const open = { ...showers, cloudCover: 0.5 };
    const closing = { ...showers, cloudCover: 0.85 };
    const light = weatherLighting(SUNSET, open);
    expect(rainbow(light, open)?.strength).toBeGreaterThan(
      rainbow(light, closing)?.strength ?? 0,
    );
    const tint = rainbow(light, open)?.tint ?? [0, 0, 0];
    expect(tint[0]).toBeGreaterThan(tint[2] * 2);
  });
});

describe("precipitation particles", () => {
  it("caps each tier, scaling with intensity", () => {
    expect(particleField(NOON, NO_WEATHER, "gpu")).toBeNull();
    const heavy = preview("heavy-rain");
    expect(particleField(NOON, heavy, "gpu")?.count).toBe(
      PARTICLE_CAPS.gpu.rain,
    );
    expect(particleField(NOON, heavy, "software")?.count).toBe(
      PARTICLE_CAPS.software.rain,
    );
    expect(particleField(NOON, preview("light-rain"), "software")?.count).toBe(
      Math.round(PARTICLE_CAPS.software.rain * 0.3),
    );
    for (const tier of ["gpu", "software"] as const)
      for (const type of ["rain", "sleet", "snow"] as const)
        expect(PARTICLE_CAPS.software[type]).toBeLessThanOrEqual(
          PARTICLE_CAPS[tier][type],
        );
  });

  it("falls slowly as snow, fast as rain, and slants with the wind", () => {
    const rain = particleField(NOON, preview("heavy-rain"), "gpu");
    const snow = particleField(NOON, preview("snow"), "gpu");
    expect(snow?.speed).toBeLessThan((rain?.speed ?? 0) / 5);
    // A west wind (blowing left on the panorama) slants the fall left.
    expect(rain?.slant).toBeLessThan(0);
    const calm = particleField(
      NOON,
      { ...preview("heavy-rain"), windX: 0 },
      "gpu",
    );
    expect(calm?.slant).toBe(0);
  });

  it("is faint at night", () => {
    const night = particleField(NIGHT, preview("heavy-rain"), "gpu");
    const day = particleField(NOON, preview("heavy-rain"), "gpu");
    expect(Math.max(...(night?.color ?? [1]))).toBeLessThan(
      Math.max(...(day?.color ?? [0])) * 0.5,
    );
  });

  it("keeps every particle on the stage, moving downward between frames", () => {
    const field = particleField(NOON, preview("heavy-rain"), "gpu");
    if (!field) throw new Error("no rain");
    for (let i = 0; i < field.count; i += 37)
      for (const t of [0, 1.5, 59.9, 1e6]) {
        const p = particleAt(field, i, t);
        expect(p.x).toBeGreaterThanOrEqual(-100);
        expect(p.x).toBeLessThan(2020);
        expect(p.y).toBeGreaterThanOrEqual(-60);
        expect(p.y).toBeLessThan(1140);
      }
    // One frame later (15 fps), most drops are lower, by under a screen.
    let fell = 0;
    for (let i = 0; i < field.count; i++) {
      const a = particleAt(field, i, 10);
      const b = particleAt(field, i, 10 + 1 / 15);
      if (b.y > a.y && b.y - a.y < 200) fell++;
    }
    expect(fell).toBeGreaterThan(field.count * 0.8);
    // Time wraps, so shaders keep their precision.
    expect(particleAt(field, 5, 7)).toEqual(
      particleAt(field, 5, 7 + PARTICLE_LOOP_SECONDS),
    );
  });

  it("hashes evenly into 0..1", () => {
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const h = hash01(i, 1);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      sum += h;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
    expect(hash01(1, 2)).not.toBe(hash01(2, 1));
  });
});
