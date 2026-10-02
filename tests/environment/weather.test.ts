import { describe, expect, it } from "vitest";
import {
  conditionsAt,
  describeConditions,
  metNorwayRequest,
  nextWeatherChange,
  parseMetNorway,
  readMetSymbol,
  STALE_GRACE_MS,
  STALE_LIMIT_MS,
  weatherAt,
} from "../../src/environment/weather.ts";
import { metDocument, SAMPLE_STEPS } from "../helpers/met-norway.ts";

const at = (iso: string) => Date.parse(iso);
const forecast = parseMetNorway(metDocument(SAMPLE_STEPS));

describe("MET Norway forecast (ADR 0020)", () => {
  it("asks for at most four decimals, whole meters, and identifies itself", () => {
    const request = metNorwayRequest(
      { latitude: 37.229_649, longitude: -80.413_96, elevationMeters: 634.6 },
      "git-flower-garden/1.0",
    );
    expect(request.url).toBe(
      "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=37.2296&lon=-80.414&altitude=635",
    );
    expect(request.headers["User-Agent"]).toBe("git-flower-garden/1.0");
  });

  it("keeps the hourly steps and normalizes them", () => {
    expect(forecast.updatedAt).toBe("2026-10-01T03:00:00Z");
    expect(forecast.hours.map((h) => h.validFrom)).toEqual([
      "2026-10-01T04:00:00.000Z",
      "2026-10-01T05:00:00.000Z",
      "2026-10-01T06:00:00.000Z",
    ]);
    expect(forecast.hours[1]).toEqual({
      validFrom: "2026-10-01T05:00:00.000Z",
      validUntil: "2026-10-01T06:00:00.000Z",
      updatedAt: "2026-10-01T03:00:00Z",
      symbol: "lightrainshowers_night",
      cloudCover: 0.9,
      fog: false,
      thunder: false,
      precipitation: {
        type: "rain",
        intensity: "light",
        showers: true,
        millimeters: 0.4,
      },
      wind: { speedMetersPerSecond: 6.2, fromDegrees: 200 },
      temperatureCelsius: 12.4,
    });
    expect(forecast.hours[2]?.precipitation).toMatchObject({
      type: "snow",
      intensity: "heavy",
      showers: false,
    });
  });

  it("reads every family of symbol codes, including the misspelled ones", () => {
    expect(readMetSymbol("clearsky_polartwilight")).toMatchObject({
      sky: "clear",
      type: "none",
    });
    expect(readMetSymbol("fog")).toMatchObject({ sky: "fog" });
    expect(readMetSymbol("rainandthunder")).toMatchObject({
      type: "rain",
      intensity: "moderate",
      thunder: true,
    });
    expect(readMetSymbol("lightssleetshowersandthunder_day")).toMatchObject({
      type: "sleet",
      intensity: "light",
      showers: true,
      thunder: true,
    });
    expect(readMetSymbol("heavysnowshowers_night")).toMatchObject({
      type: "snow",
      intensity: "heavy",
      showers: true,
    });
    expect(readMetSymbol("volcanic_ash")).toBeNull();
  });

  it("falls back to the amount and temperature for an unknown symbol", () => {
    const hours = parseMetNorway(
      metDocument([
        {
          time: "2026-01-01T00:00:00Z",
          symbol: "new",
          millimeters: 2,
          temperature: -3,
        },
        { time: "2026-01-01T01:00:00Z", symbol: "new", millimeters: 0 },
      ]),
    ).hours;
    expect(hours[0]?.precipitation).toMatchObject({
      type: "snow",
      intensity: "moderate",
    });
    expect(hours[1]?.precipitation.type).toBe("none");
  });

  it("rejects a document that is not a forecast", () => {
    expect(() => parseMetNorway({ error: "nope" })).toThrow(/not a MET Norway/);
    expect(() => parseMetNorway(null)).toThrow();
  });
});

describe("weather freshness", () => {
  const record = {
    fetchedAt: at("2026-10-01T04:10:00Z"),
    expiresAt: at("2026-10-01T04:40:00Z"),
  };

  it("picks the hour containing now", () => {
    expect(conditionsAt(forecast, at("2026-10-01T05:59:59Z"))?.symbol).toBe(
      "lightrainshowers_night",
    );
    expect(conditionsAt(forecast, at("2026-10-01T03:59:00Z"))).toBeNull();
    expect(conditionsAt(forecast, at("2026-10-01T07:00:00Z"))).toBeNull();
  });

  it("is waiting, fresh, stale, then unavailable", () => {
    expect(weatherAt(null, null, record.fetchedAt, false).state).toBe(
      "waiting",
    );
    expect(weatherAt(null, null, record.fetchedAt, true).state).toBe(
      "unavailable",
    );
    const fresh = weatherAt(forecast, record, at("2026-10-01T04:50:00Z"), true);
    expect(fresh.state).toBe("fresh");
    expect(fresh.conditions?.provider.id).toBe("met-norway");
    expect(fresh.conditions?.kind).toBe("forecast");
    expect(
      weatherAt(forecast, record, record.expiresAt + STALE_GRACE_MS, true)
        .state,
    ).toBe("stale");
    // Past the forecast's hours, or too long since a fetch: neutral weather.
    expect(
      weatherAt(forecast, record, at("2026-10-01T07:00:00Z"), true),
    ).toEqual({ state: "unavailable", conditions: null });
    const longForecast = parseMetNorway(
      metDocument(
        Array.from({ length: 12 }, (_, i) => ({
          time: new Date(
            at("2026-10-01T04:00:00Z") + i * 3_600_000,
          ).toISOString(),
        })),
      ),
    );
    expect(
      weatherAt(
        longForecast,
        record,
        record.fetchedAt + STALE_LIMIT_MS - 1,
        true,
      ).state,
    ).toBe("stale");
    expect(
      weatherAt(longForecast, record, record.fetchedAt + STALE_LIMIT_MS, true)
        .state,
    ).toBe("unavailable");
  });

  it("names the next change: the hour boundary, then staleness", () => {
    expect(
      nextWeatherChange(forecast, record, at("2026-10-01T04:20:00Z")),
    ).toBe(at("2026-10-01T04:55:00Z"));
    expect(
      nextWeatherChange(forecast, record, at("2026-10-01T04:56:00Z")),
    ).toBe(at("2026-10-01T05:00:00Z"));
    expect(nextWeatherChange(null, null, 0)).toBeNull();
  });
});

describe("weather words", () => {
  it("describes conditions briefly", () => {
    const c = conditionsAt(forecast, at("2026-10-01T05:30:00Z"));
    expect(c && describeConditions(c)).toBe(
      "light rain showers, 12 °C, wind 6 m/s from S",
    );
    const calm = conditionsAt(forecast, at("2026-10-01T04:30:00Z"));
    expect(
      calm &&
        describeConditions({
          ...calm,
          wind: { speedMetersPerSecond: 0.2, fromDegrees: 0 },
        }),
    ).toBe("partly cloudy, 17 °C, calm");
  });
});
