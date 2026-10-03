/**
 * Wind controls in the top bar, for previewing the grass and clouds in any
 * wind: where it blows from, its speed from still air to a hurricane, and
 * how much harder its gusts blow. "Weather" leaves the wind to the live
 * conditions or the weather preview. The view faces south, so a north wind
 * blows into the scene and a west wind to the right.
 */
import type { WeatherEffects } from "../environment/weather-effects.ts";

/** Compass points the wind can blow from, clockwise from north. */
export const WIND_FROM = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type WindFrom = "weather" | (typeof WIND_FROM)[number];

export interface WindSetting {
  from: WindFrom;
  speedMph: number;
  /** How much faster than `speedMph` the gusts blow. */
  gustMph: number;
}

/** The wind as the weather has it. */
export const WEATHER_WIND: WindSetting = {
  from: "weather",
  speedMph: 0,
  gustMph: 0,
};

/** Past a Category 5 hurricane's threshold (157 mph). */
export const MAX_SPEED_MPH = 160;
export const MAX_GUST_MPH = 80;
const MPH = 0.44704;

/** A plain name for a wind of `mph`, after the Beaufort scale. */
export function windName(mph: number): string {
  if (mph < 1) return "calm";
  if (mph < 13) return "light breeze";
  if (mph < 25) return "breeze";
  if (mph < 39) return "strong wind";
  if (mph < 55) return "gale";
  if (mph < 74) return "storm";
  return "hurricane";
}

/** The weather's effects with the chosen wind in place of the forecast's. */
export function applyWind(
  effects: WeatherEffects,
  setting: WindSetting,
): WeatherEffects {
  if (setting.from === "weather") return effects;
  const speed = setting.speedMph * MPH;
  const from = WIND_FROM.indexOf(setting.from) * 45;
  // As weatherEffects does: toward the opposite point, the viewer facing south.
  const toward = ((from + 180) * Math.PI) / 180;
  return {
    ...effects,
    windX: -Math.sin(toward) * speed,
    windZ: -Math.cos(toward) * speed,
    windSpeed: speed,
    windGust: setting.gustMph * MPH,
  };
}

/** A sentence for the art notice, or null for the weather's own wind. */
export function describeWind(setting: WindSetting): string | null {
  if (setting.from === "weather") return null;
  return `From ${setting.from}, ${String(setting.speedMph)} mph (${windName(setting.speedMph)}), gusts ${String(setting.gustMph)} mph harder.`;
}

export function WindControls({
  setting,
  effects,
  onChange,
}: {
  setting: WindSetting;
  /** The weather's own wind, where the sliders start. */
  effects: WeatherEffects;
  onChange: (next: WindSetting) => void;
}) {
  const custom = setting.from !== "weather";
  return (
    <>
      <label
        className="preview-control"
        title="The view faces south: a north wind blows into the scene, a west wind to the right."
      >
        Wind
        <select
          aria-label="Wind direction"
          value={setting.from}
          onChange={(event) => {
            const from = event.target.value as WindFrom;
            onChange(
              from === "weather"
                ? WEATHER_WIND
                : custom
                  ? { ...setting, from }
                  : {
                      from,
                      // Start from the weather's wind.
                      speedMph: Math.round(effects.windSpeed / MPH),
                      gustMph: Math.round(effects.windGust / MPH),
                    },
            );
          }}
        >
          <option value="weather">Weather</option>
          {WIND_FROM.map((from) => (
            <option key={from} value={from}>
              From {from}
            </option>
          ))}
        </select>
      </label>
      {custom && (
        <>
          <label className="preview-control time-control">
            Speed
            <input
              type="range"
              aria-label="Wind speed"
              aria-valuetext={`${String(setting.speedMph)} mph, ${windName(setting.speedMph)}`}
              min={0}
              max={MAX_SPEED_MPH}
              step={1}
              value={setting.speedMph}
              onChange={(event) => {
                onChange({ ...setting, speedMph: Number(event.target.value) });
              }}
            />
            <output className="wind-readout">
              {setting.speedMph} mph · {windName(setting.speedMph)}
            </output>
          </label>
          <label className="preview-control time-control">
            Gusts
            <input
              type="range"
              aria-label="Gust strength"
              aria-valuetext={`${String(setting.gustMph)} mph above the wind`}
              min={0}
              max={MAX_GUST_MPH}
              step={1}
              value={setting.gustMph}
              onChange={(event) => {
                onChange({ ...setting, gustMph: Number(event.target.value) });
              }}
            />
            <output className="wind-readout">+{setting.gustMph} mph</output>
          </label>
        </>
      )}
    </>
  );
}
