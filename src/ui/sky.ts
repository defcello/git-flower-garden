/**
 * The garden's sky from the lighting model (ADR 0018): the live sky at the
 * configured place, or a labelled preview. The scene is drawn from it by
 * SceneCanvas.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import type { EnvironmentJson } from "../api/types.ts";
import {
  environmentSnapshot,
  type EnvironmentSnapshot,
} from "../environment/environment.ts";
import { lightingState, type LightingState } from "../environment/lighting.ts";
import {
  PREVIEWS,
  isPreviewName,
  previewSnapshot,
  type PreviewName,
} from "../environment/overrides.ts";

/** "live" follows the configured place and the clock; otherwise a preview. */
export type SkyChoice = "live" | PreviewName;

export const SKY_CHOICES: { value: SkyChoice; label: string }[] = [
  { value: "live", label: "Live" },
  ...Object.entries(PREVIEWS).map(([value, preview]) => ({
    value: value as PreviewName,
    label: `Preview · ${preview.label}`,
  })),
];

export function parseSkyChoice(value: string): SkyChoice {
  return isPreviewName(value) ? value : "live";
}

export interface Sky {
  snapshot: EnvironmentSnapshot;
  state: LightingState;
}

const LIVE_REFRESH_MS = 60_000;

/**
 * The current sky, or null when "live" is chosen but no place is configured
 * (the garden is then lit by `DAYTIME`). Live skies are recomputed
 * once a minute while the page is visible, and at once when it is shown.
 */
export function useSky(
  environment: EnvironmentJson | null,
  choice: SkyChoice,
): Sky | null {
  const [now, setNow] = useState(() => Date.now());
  const live = choice === "live" && environment !== null;
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
    if (choice !== "live") snapshot = previewSnapshot(choice);
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
  }, [choice, now, latitude, longitude, elevationMeters, timeZone]);
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
