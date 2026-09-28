/**
 * The garden's sky from the lighting model (ADR 0018): the live sky at the
 * configured place, or the sky at a chosen time. A time is chosen with the
 * time-of-day slider or a bookmark (a developer preview, which also sets the
 * date and place). The scene is drawn from it by SceneCanvas.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import type { EnvironmentJson } from "../api/types.ts";
import type { Place } from "../environment/astronomy.ts";
import {
  environmentSnapshot,
  type EnvironmentSnapshot,
} from "../environment/environment.ts";
import { lightingState, type LightingState } from "../environment/lighting.ts";
import {
  PREVIEWS,
  isPreviewName,
  type PreviewName,
} from "../environment/overrides.ts";

/**
 * "live" follows the configured place and the clock; "fixed" shows one
 * instant, from a bookmark or the slider (`bookmark` null: a custom time).
 */
export type SkySetting =
  | { mode: "live" }
  | {
      mode: "fixed";
      time: number;
      place: Place;
      timeZone: string;
      bookmark: PreviewName | null;
    };

export const LIVE: SkySetting = { mode: "live" };

export const SKY_BOOKMARKS: { value: "live" | PreviewName; label: string }[] = [
  { value: "live", label: "Live" },
  ...Object.entries(PREVIEWS).map(([value, preview]) => ({
    value: value as PreviewName,
    label: `Preview · ${preview.label}`,
  })),
];

/** The setting a bookmark stands for: live, or a preview's instant and place. */
export function bookmarkSetting(value: string): SkySetting {
  if (!isPreviewName(value)) return LIVE;
  const preview = PREVIEWS[value];
  return {
    mode: "fixed",
    time: Date.parse(preview.time),
    place: preview.place,
    timeZone: preview.timeZone,
    bookmark: value,
  };
}

export interface Sky {
  snapshot: EnvironmentSnapshot;
  state: LightingState;
}

const LIVE_REFRESH_MS = 60_000;

/**
 * The current sky, or null when live is chosen but no place is configured
 * (the garden is then lit by `DAYTIME`). Live skies are recomputed once a
 * minute while the page is visible, and at once when it is shown. A fixed
 * time is marked as a preview (`custom` when no bookmark names it), so it is
 * never taken for live conditions.
 */
export function useSky(
  environment: EnvironmentJson | null,
  setting: SkySetting,
): Sky | null {
  const [now, setNow] = useState(() => Date.now());
  const live = setting.mode === "live" && environment !== null;
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      setNow(Date.now());
    };
    const sync = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (document.hidden) return;
      tick();
      timer = setInterval(tick, LIVE_REFRESH_MS);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (timer !== null) clearInterval(timer);
    };
  }, [live]);

  const latitude = environment?.latitude;
  const longitude = environment?.longitude;
  const elevationMeters = environment?.elevationMeters;
  const timeZone = environment?.timeZone;
  return useMemo(() => {
    let snapshot: EnvironmentSnapshot;
    if (setting.mode === "fixed")
      snapshot = environmentSnapshot(
        new Date(setting.time),
        setting.place,
        setting.timeZone,
        setting.bookmark ?? "custom",
      );
    else if (
      latitude === undefined ||
      longitude === undefined ||
      timeZone === undefined
    )
      return null;
    else
      snapshot = environmentSnapshot(
        new Date(now),
        { latitude, longitude, elevationMeters: elevationMeters ?? 0 },
        timeZone,
      );
    return { snapshot, state: lightingState(snapshot) };
  }, [setting, now, latitude, longitude, elevationMeters, timeZone]);
}

export function describeSky(sky: Sky): string {
  const { snapshot, state } = sky;
  const moon = state.moon;
  const phase =
    moon.illuminatedFraction < 0.03
      ? "new moon"
      : `moon ${String(Math.round(moon.illuminatedFraction * 100))}% ${moon.waxing ? "waxing" : "waning"}`;
  const where = `${snapshot.place.latitude.toFixed(2)}°, ${snapshot.place.longitude.toFixed(2)}°`;
  const sun = `sun ${String(Math.round(state.sun.altitude))}°`;
  const moonAltitude = `${String(Math.round(moon.altitude))}°`;
  return `${snapshot.localTime} at ${where} · ${state.twilight} · ${sun} · ${phase} at ${moonAltitude}`;
}
