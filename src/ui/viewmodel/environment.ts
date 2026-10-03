/**
 * The environment's view model (ADR 0022): the sky and weather a renderer
 * draws, after the viewer's time and weather choices are applied. The shell
 * computes it once (shell/use-environment.ts) for renderers that declare
 * `usesEnvironment`; every such renderer sees the same light.
 */
import type { LightingState } from "../../environment/lighting.ts";
import {
  NO_WEATHER,
  rainbow,
  weatherLighting,
  type WeatherEffects,
} from "../../environment/weather-effects.ts";
import type { EnvironmentSnapshot } from "../../environment/environment.ts";

/** The sky at one instant: where it is computed for, and its light. */
export interface Sky {
  snapshot: EnvironmentSnapshot;
  state: LightingState;
}

export interface SceneEnvironment {
  /** The computed sky and its snapshot; null when live is chosen but no place is configured. */
  sky: Sky | null;
  /** The requested light, with the weather applied. */
  light: LightingState;
  /**
   * The light the garden scene currently shows, which can trail `light`
   * while its art is relit; equal to `light` for renderers that relight at once.
   */
  shownLight: LightingState;
  /** The forecast (or weather preview) before the viewer's wind controls. */
  forecast: WeatherEffects;
  /** The weather to draw, wind controls applied; `NO_WEATHER` when there is none. */
  effects: WeatherEffects;
  /** Weather plus the sky's clock in whole minutes, for seeded motion; null without weather. */
  weather: { effects: WeatherEffects; minutes: number } | null;
  /** A rainbow is in the sky (inferred from the forecast, not observed). */
  rainbow: boolean;
  /** After civil dusk. */
  night: boolean;
  /** Whether the sky or the weather is a preview rather than live conditions. */
  preview: { sky: boolean; weather: string | null };
}

/** After civil dusk: panels over the scene turn dark. */
export function isNight(light: LightingState): boolean {
  return light.sun.altitude < -6;
}

export function sceneEnvironment(
  sky: Sky | null,
  baseLight: LightingState,
  effects: WeatherEffects,
  weatherPreview: string | null,
): Omit<SceneEnvironment, "shownLight" | "forecast"> {
  const light = weatherLighting(baseLight, effects);
  const minutes = Math.floor((sky?.snapshot.time.getTime() ?? 0) / 60_000);
  return {
    sky,
    light,
    effects,
    weather: effects === NO_WEATHER ? null : { effects, minutes },
    rainbow: rainbow(light, effects) !== null,
    night: isNight(light),
    preview: {
      sky: sky?.snapshot.source === "preview",
      weather: weatherPreview,
    },
  };
}
