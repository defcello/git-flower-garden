/**
 * Synthetic MET Norway Locationforecast 2.0 compact documents, in the
 * provider's shape (fields and units as served in 2026), for weather tests.
 * The values are invented.
 */

export interface MetStep {
  time: string;
  temperature?: number;
  cloud?: number;
  windSpeed?: number;
  windFrom?: number;
  symbol?: string;
  millimeters?: number;
  /** Omit the one-hour summary (as in the forecast's later, six-hourly steps). */
  sixHourly?: boolean;
}

export function metDocument(
  steps: MetStep[],
  updatedAt = "2026-10-01T03:00:00Z",
): unknown {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-80.4139, 37.2296, 634] },
    properties: {
      meta: {
        updated_at: updatedAt,
        units: {
          air_pressure_at_sea_level: "hPa",
          air_temperature: "celsius",
          cloud_area_fraction: "%",
          precipitation_amount: "mm",
          relative_humidity: "%",
          wind_from_direction: "degrees",
          wind_speed: "m/s",
        },
      },
      timeseries: steps.map((step) => ({
        time: step.time,
        data: {
          instant: {
            details: {
              air_pressure_at_sea_level: 1020.2,
              air_temperature: step.temperature ?? 17.2,
              cloud_area_fraction: step.cloud ?? 61.7,
              relative_humidity: 84.8,
              wind_from_direction: step.windFrom ?? 245,
              wind_speed: step.windSpeed ?? 2.5,
            },
          },
          ...(step.sixHourly
            ? {}
            : {
                next_1_hours: {
                  summary: { symbol_code: step.symbol ?? "partlycloudy_night" },
                  details: { precipitation_amount: step.millimeters ?? 0 },
                },
              }),
          next_6_hours: {
            summary: { symbol_code: "clearsky_night" },
            details: { precipitation_amount: 0 },
          },
        },
      })),
    },
  };
}

/** Three hourly steps from 04:00Z on 2026-10-01, then a six-hourly one. */
export const SAMPLE_STEPS: MetStep[] = [
  { time: "2026-10-01T04:00:00Z" },
  {
    time: "2026-10-01T05:00:00Z",
    symbol: "lightrainshowers_night",
    millimeters: 0.4,
    cloud: 90,
    windSpeed: 6.2,
    windFrom: 200,
    temperature: 12.4,
  },
  { time: "2026-10-01T06:00:00Z", symbol: "heavysnow", millimeters: 5 },
  { time: "2026-10-01T12:00:00Z", sixHourly: true },
];
