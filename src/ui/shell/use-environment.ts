/**
 * The environment view model for the current renderer (ADR 0022): the sky
 * at the viewer's chosen time, the live or previewed weather, and the light
 * they make together. Computed only for renderers that use it.
 */
import { useEffect, useMemo } from "react";
import type { EnvironmentJson } from "../../api/types.ts";
import {
  NO_WEATHER,
  weatherEffects,
} from "../../environment/weather-effects.ts";
import {
  previewConditions,
  type WeatherPreviewName,
} from "../../environment/weather-previews.ts";
import { useShownLight } from "../scene/client.ts";
import { DAYTIME } from "../scene/view.ts";
import { LIVE, useSky, type SkySetting } from "../sky.ts";
import { setSwayWind } from "../sway.ts";
import {
  isNight,
  sceneEnvironment,
  type SceneEnvironment,
} from "../viewmodel/environment.ts";

export type WeatherSetting = "live" | WeatherPreviewName;

export function useSceneEnvironment(
  enabled: boolean,
  environment: EnvironmentJson | null,
  skySetting: SkySetting,
  weatherSetting: WeatherSetting,
): SceneEnvironment | null {
  const sky = useSky(enabled ? environment : null, enabled ? skySetting : LIVE);
  // Weather: live conditions with the live sky, or a developer preview;
  // none for a chosen time, which live conditions do not describe.
  const liveConditions =
    sky?.snapshot.source === "live"
      ? (environment?.weather?.conditions ?? null)
      : null;
  const skyTime = sky?.snapshot.time.getTime() ?? null;
  const previewHour =
    skyTime === null ? 0 : Math.floor(skyTime / 3_600_000) * 3_600_000;
  // Every server message parses anew; the weather changes far less often.
  const liveKey = JSON.stringify(liveConditions);
  const effects = useMemo(
    () =>
      !enabled
        ? NO_WEATHER
        : weatherSetting === "live"
          ? weatherEffects(liveConditions)
          : weatherEffects(previewConditions(weatherSetting, previewHour)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, weatherSetting, liveKey, previewHour],
  );
  const baseLight = sky?.state ?? DAYTIME;
  const skyMinutes = Math.floor((skyTime ?? 0) / 60_000);
  const scene = useMemo(
    () =>
      sceneEnvironment(
        sky,
        baseLight,
        effects,
        weatherSetting === "live" ? null : weatherSetting,
      ),
    // The sky's identity changes each minute; weather needs only its minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sky, baseLight, effects, weatherSetting, skyMinutes],
  );
  useEffect(() => {
    setSwayWind(
      effects === NO_WEATHER ? null : effects.windSpeed,
      effects.windX,
    );
  }, [effects]);
  // Plant shadows and night panels change with the relit art, not ahead of it.
  const shownLight = useShownLight(scene.light);
  return useMemo(
    () =>
      enabled ? { ...scene, shownLight, night: isNight(shownLight) } : null,
    [enabled, scene, shownLight],
  );
}
