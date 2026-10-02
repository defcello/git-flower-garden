/**
 * Weather for the garden (roadmap P2-D, ADR 0020): conditions normalized from
 * a provider, and how fresh they are. Pure code shared by the server, which
 * fetches, and the UI, which shows and (later) draws them.
 *
 * Conditions are a model forecast for the hour, never a local observation;
 * the UI says so, with the source and the hour they are valid for.
 */

export type PrecipitationType = "none" | "rain" | "sleet" | "snow";
export type Intensity = "none" | "light" | "moderate" | "heavy";

export interface WeatherConditions {
  /** Modelled conditions; no provider here reports observations. */
  kind: "forecast";
  provider: WeatherProviderInfo;
  /** The hour these conditions describe: `validFrom` up to `validUntil` (ISO). */
  validFrom: string;
  validUntil: string;
  /** When the provider last updated the forecast (ISO). */
  updatedAt: string;
  /** The provider's condition code, e.g. `lightrainshowers_day`. */
  symbol: string | null;
  /** Fraction of the sky covered by cloud, 0..1. */
  cloudCover: number;
  fog: boolean;
  thunder: boolean;
  precipitation: {
    type: PrecipitationType;
    intensity: Intensity;
    /** Showers (convective, with breaks) rather than steady precipitation. */
    showers: boolean;
    /** Expected over the hour, millimeters (water equivalent). */
    millimeters: number;
  };
  wind: { speedMetersPerSecond: number; fromDegrees: number };
  temperatureCelsius: number;
}

export interface WeatherProviderInfo {
  /** `preview`: a developer preview, never live conditions. */
  id: "met-norway" | "preview";
  name: string;
  /** Required credit (the data license is CC BY 4.0). */
  attribution: string;
  url: string;
}

export const MET_NORWAY: WeatherProviderInfo = {
  id: "met-norway",
  name: "MET Norway",
  attribution:
    "Weather data from MET Norway (Norwegian Meteorological Institute), CC BY 4.0",
  url: "https://api.met.no/",
};

/**
 * What the garden knows about the weather:
 * - `waiting`: enabled, and no forecast has arrived yet;
 * - `fresh`: the last fetch is current by the provider's own schedule;
 * - `stale`: fetching has failed for a while; the last forecast still shows,
 *   marked stale, until `STALE_LIMIT_MS` after it was fetched;
 * - `unavailable`: nothing usable; the scene shows neutral weather.
 */
export type WeatherState = "waiting" | "fresh" | "stale" | "unavailable";

/** After this long without a successful fetch, a forecast is dropped. */
export const STALE_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Lateness past the provider's expiry before weather is shown as stale. */
export const STALE_GRACE_MS = 15 * 60 * 1000;

/** One hour of a provider's forecast, normalized. */
export type ForecastHour = Omit<WeatherConditions, "kind" | "provider">;

/** A parsed forecast: the hours it covers, in time order. */
export interface Forecast {
  provider: WeatherProviderInfo;
  updatedAt: string;
  hours: ForecastHour[];
}

/** The hour of `forecast` that contains `now`, or null when it covers none. */
export function conditionsAt(
  forecast: Forecast,
  now: number,
): WeatherConditions | null {
  for (const hour of forecast.hours) {
    if (Date.parse(hour.validFrom) <= now && now < Date.parse(hour.validUntil))
      return { kind: "forecast", provider: forecast.provider, ...hour };
  }
  return null;
}

/** The provider's freshness, from the last successful fetch. */
export interface FetchRecord {
  /** When the forecast was last fetched or confirmed unchanged (ms). */
  fetchedAt: number;
  /** When the provider says to ask again (ms). */
  expiresAt: number;
}

/** Freshness and the conditions to show at `now`. */
export function weatherAt(
  forecast: Forecast | null,
  record: FetchRecord | null,
  now: number,
  attempted: boolean,
): { state: WeatherState; conditions: WeatherConditions | null } {
  if (!forecast || !record)
    return { state: attempted ? "unavailable" : "waiting", conditions: null };
  const conditions = conditionsAt(forecast, now);
  if (!conditions || now - record.fetchedAt >= STALE_LIMIT_MS)
    return { state: "unavailable", conditions: null };
  const late =
    now >= Math.max(record.expiresAt, record.fetchedAt) + STALE_GRACE_MS;
  return { state: late ? "stale" : "fresh", conditions };
}

/** The next instant `weatherAt` can change without a new fetch. */
export function nextWeatherChange(
  forecast: Forecast | null,
  record: FetchRecord | null,
  now: number,
): number | null {
  if (!forecast || !record) return null;
  const candidates = [
    Math.max(record.expiresAt, record.fetchedAt) + STALE_GRACE_MS,
    record.fetchedAt + STALE_LIMIT_MS,
    ...forecast.hours.flatMap((h) => [
      Date.parse(h.validFrom),
      Date.parse(h.validUntil),
    ]),
  ].filter((t) => Number.isFinite(t) && t > now);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

// --- MET Norway Locationforecast 2.0 (compact) ------------------------------

const HOUR_MS = 60 * 60 * 1000;

/**
 * The request for the forecast at a place. MET Norway asks for at most four
 * decimals (about 11 m) and whole meters of altitude, and for a User-Agent
 * that identifies the application and how to reach its maintainers.
 */
export function metNorwayRequest(
  place: { latitude: number; longitude: number; elevationMeters?: number },
  userAgent: string,
): { url: string; headers: Record<string, string> } {
  const round4 = (v: number) => String(Math.round(v * 1e4) / 1e4);
  const params = new URLSearchParams({
    lat: round4(place.latitude),
    lon: round4(place.longitude),
  });
  if (place.elevationMeters !== undefined)
    params.set("altitude", String(Math.round(place.elevationMeters)));
  return {
    url: `https://api.met.no/weatherapi/locationforecast/2.0/compact?${params.toString()}`,
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  };
}

/** A MET Norway symbol code, read into conditions (`null`: not recognized). */
export function readMetSymbol(symbol: string): {
  sky: "clear" | "fair" | "partly" | "cloudy" | "fog";
  type: PrecipitationType;
  intensity: Intensity;
  showers: boolean;
  thunder: boolean;
} | null {
  const base = symbol.replace(/_(day|night|polartwilight)$/, "");
  const skies: Partial<
    Record<string, "clear" | "fair" | "partly" | "cloudy" | "fog">
  > = {
    clearsky: "clear",
    fair: "fair",
    partlycloudy: "partly",
    cloudy: "cloudy",
    fog: "fog",
  };
  const sky = skies[base];
  if (sky)
    return {
      sky,
      type: "none",
      intensity: "none",
      showers: false,
      thunder: false,
    };
  // MET Norway spells two codes with an extra "s" ("lightssleetshowersandthunder").
  const match =
    /^(lights?|heavy)?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(base);
  if (!match) return null;
  const [, strength, type, showers, thunder] = match;
  return {
    sky: "cloudy",
    type: type as PrecipitationType,
    intensity: strength?.startsWith("light")
      ? "light"
      : strength === "heavy"
        ? "heavy"
        : "moderate",
    showers: showers !== undefined,
    thunder: thunder !== undefined,
  };
}

/** Intensity from an hour's amount, when the symbol does not say. */
function intensityOf(millimeters: number): Intensity {
  if (millimeters <= 0) return "none";
  if (millimeters < 1) return "light";
  if (millimeters < 4) return "moderate";
  return "heavy";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parse a Locationforecast 2.0 compact response into hourly conditions.
 * Only the hours with a one-hour summary are kept (the first two or three
 * days); later six-hourly steps are not needed for the current sky. Throws
 * when the document is not a forecast.
 */
export function parseMetNorway(json: unknown): Forecast {
  const properties = record(record(json).properties);
  const meta = record(properties.meta);
  const updatedAt = meta.updated_at;
  const timeseries = properties.timeseries;
  if (typeof updatedAt !== "string" || !Array.isArray(timeseries))
    throw new Error("not a MET Norway forecast (missing meta or timeseries)");
  const hours: ForecastHour[] = [];
  for (const step of timeseries) {
    const time = record(step).time;
    const data = record(record(step).data);
    const details = record(record(data.instant).details);
    const next = record(data.next_1_hours);
    if (typeof time !== "string" || Object.keys(next).length === 0) continue;
    const start = Date.parse(time);
    const temperature = finite(details.air_temperature);
    const cloud = finite(details.cloud_area_fraction);
    if (!Number.isFinite(start) || temperature === null || cloud === null)
      continue;
    const symbol = record(next.summary).symbol_code;
    const code = typeof symbol === "string" ? symbol : null;
    const read = code === null ? null : readMetSymbol(code);
    const millimeters = Math.max(
      0,
      finite(record(next.details).precipitation_amount) ?? 0,
    );
    // Unrecognized symbol: judge by the amount and the temperature.
    const type: PrecipitationType =
      read?.type ??
      (millimeters > 0 ? (temperature <= 0 ? "snow" : "rain") : "none");
    hours.push({
      validFrom: new Date(start).toISOString(),
      validUntil: new Date(start + HOUR_MS).toISOString(),
      updatedAt,
      symbol: code,
      cloudCover: Math.min(1, Math.max(0, cloud / 100)),
      fog:
        read?.sky === "fog" || (finite(details.fog_area_fraction) ?? 0) >= 50,
      thunder: read?.thunder ?? false,
      precipitation: {
        type,
        intensity:
          type === "none"
            ? "none"
            : (read?.intensity ?? intensityOf(millimeters)),
        showers: read?.showers ?? false,
        millimeters,
      },
      wind: {
        speedMetersPerSecond: Math.max(0, finite(details.wind_speed) ?? 0),
        fromDegrees: finite(details.wind_from_direction) ?? 0,
      },
      temperatureCelsius: temperature,
    });
  }
  hours.sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
  return { provider: MET_NORWAY, updatedAt, hours };
}

// --- Words for the environment details ---------------------------------------

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** A short description, e.g. "light rain showers, 12 °C, wind 4 m/s from SW". */
export function describeConditions(c: WeatherConditions): string {
  const p = c.precipitation;
  let what: string;
  if (p.type !== "none") {
    const strength = p.intensity === "moderate" ? "" : `${p.intensity} `;
    what = `${strength}${p.type}${p.showers ? " showers" : ""}`;
  } else if (c.fog) what = "fog";
  else if (c.cloudCover < 0.125) what = "clear";
  else if (c.cloudCover < 0.375) what = "mostly clear";
  else if (c.cloudCover < 0.875) what = "partly cloudy";
  else what = "overcast";
  if (c.thunder) what += " with thunder";
  const compass =
    COMPASS[Math.round((((c.wind.fromDegrees % 360) + 360) % 360) / 45) % 8] ??
    "N";
  const wind =
    c.wind.speedMetersPerSecond < 0.5
      ? "calm"
      : `wind ${String(Math.round(c.wind.speedMetersPerSecond))} m/s from ${compass}`;
  return `${what}, ${String(Math.round(c.temperatureCelsius))} °C, ${wind}`;
}
