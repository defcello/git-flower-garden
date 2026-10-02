/**
 * Developer previews of the weather (roadmap P2-D): one condition each, as
 * normalized conditions, so they pass through the same effects as live
 * weather. Always labelled "Weather preview" and never taken for live
 * conditions. Each case is checked in tests/environment/weather-effects.test.ts.
 */
import type { WeatherConditions } from "./weather.ts";

type Preview = Pick<
  WeatherConditions,
  "cloudCover" | "fog" | "thunder" | "precipitation"
> & { label: string; wind?: number; windFrom?: number };

const dry = {
  type: "none",
  intensity: "none",
  showers: false,
  millimeters: 0,
} as const;

export const WEATHER_PREVIEWS = {
  clear: {
    label: "Clear",
    cloudCover: 0,
    fog: false,
    thunder: false,
    precipitation: dry,
  },
  "partly-cloudy": {
    label: "Partly cloudy",
    cloudCover: 0.45,
    fog: false,
    thunder: false,
    precipitation: dry,
  },
  overcast: {
    label: "Overcast",
    cloudCover: 1,
    fog: false,
    thunder: false,
    precipitation: dry,
  },
  fog: {
    label: "Fog",
    cloudCover: 0.9,
    fog: true,
    thunder: false,
    precipitation: dry,
  },
  "light-rain": {
    label: "Light rain",
    cloudCover: 0.95,
    fog: false,
    thunder: false,
    precipitation: {
      type: "rain",
      intensity: "light",
      showers: false,
      millimeters: 0.4,
    },
  },
  "heavy-rain": {
    label: "Heavy rain",
    cloudCover: 1,
    fog: false,
    thunder: false,
    precipitation: {
      type: "rain",
      intensity: "heavy",
      showers: false,
      millimeters: 6,
    },
    wind: 6,
  },
  showers: {
    label: "Showers (a rainbow when sunlit)",
    cloudCover: 0.55,
    fog: false,
    thunder: false,
    precipitation: {
      type: "rain",
      intensity: "moderate",
      showers: true,
      millimeters: 1.5,
    },
  },
  thunderstorm: {
    label: "Thunderstorm",
    cloudCover: 1,
    fog: false,
    thunder: true,
    precipitation: {
      type: "rain",
      intensity: "heavy",
      showers: true,
      millimeters: 8,
    },
    wind: 9,
  },
  sleet: {
    label: "Sleet",
    cloudCover: 1,
    fog: false,
    thunder: false,
    precipitation: {
      type: "sleet",
      intensity: "moderate",
      showers: false,
      millimeters: 1.5,
    },
  },
  snow: {
    label: "Snow",
    cloudCover: 1,
    fog: false,
    thunder: false,
    precipitation: {
      type: "snow",
      intensity: "moderate",
      showers: false,
      millimeters: 1,
    },
    wind: 2,
  },
  "high-wind": {
    label: "High wind",
    cloudCover: 0.5,
    fog: false,
    thunder: false,
    precipitation: dry,
    wind: 16,
  },
} as const satisfies Record<string, Preview>;

export type WeatherPreviewName = keyof typeof WEATHER_PREVIEWS;

export const WEATHER_PREVIEW_NAMES = Object.keys(
  WEATHER_PREVIEWS,
) as WeatherPreviewName[];

export function isWeatherPreviewName(
  value: string,
): value is WeatherPreviewName {
  return Object.hasOwn(WEATHER_PREVIEWS, value);
}

/** The preview as conditions for `now` (a model forecast in name only). */
export function previewConditions(
  name: WeatherPreviewName,
  now: number,
): WeatherConditions {
  const p: Preview = WEATHER_PREVIEWS[name];
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  return {
    kind: "forecast",
    provider: {
      id: "preview",
      name: "Weather preview",
      attribution: "Weather preview (not live conditions)",
      url: "",
    },
    validFrom: new Date(hour).toISOString(),
    validUntil: new Date(hour + 3_600_000).toISOString(),
    updatedAt: new Date(hour).toISOString(),
    symbol: null,
    cloudCover: p.cloudCover,
    fog: p.fog,
    thunder: p.thunder,
    precipitation: p.precipitation,
    // From the west by default: the Blue Ridge's prevailing wind.
    wind: { speedMetersPerSecond: p.wind ?? 3, fromDegrees: p.windFrom ?? 270 },
    temperatureCelsius: p.precipitation.type === "snow" ? -2 : 12,
  };
}
