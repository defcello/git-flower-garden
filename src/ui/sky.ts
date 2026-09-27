/**
 * The garden's sky from the lighting model (ADR 0018 step 1). Until layered
 * art exists, the flat backdrop is graded continuously from the lighting
 * state and the Sun, Moon, and stars are drawn over its painted sky.
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
 * (the garden then keeps its daytime backdrop). Live skies are recomputed
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Grade {
  brightness: number;
  saturate: number;
  sepia: number;
}

// The four accepted P2-A studies, placed on the Sun's altitude.
const GRADES: readonly [[number, Grade], ...[number, Grade][]] = [
  [-12, { brightness: 0.28, saturate: 0.4, sepia: 0 }],
  [-4, { brightness: 0.65, saturate: 0.7, sepia: 0.3 }],
  [2, { brightness: 0.9, saturate: 0.75, sepia: 0.25 }],
  [15, { brightness: 1, saturate: 1, sepia: 0 }],
];

function gradeFor(state: LightingState): Grade {
  const altitude = state.sun.altitude;
  let grade: Grade = GRADES[0][1];
  for (let i = 0; i < GRADES.length; i++) {
    const [edge, value] = GRADES[i] ?? GRADES[0];
    if (altitude >= edge) {
      grade = value;
      continue;
    }
    if (i === 0) break;
    const [lowEdge, low] = GRADES[i - 1] ?? GRADES[0];
    const t = (altitude - lowEdge) / (edge - lowEdge);
    grade = {
      brightness: lerp(low.brightness, value.brightness, t),
      saturate: lerp(low.saturate, value.saturate, t),
      sepia: lerp(low.sepia, value.sepia, t),
    };
    break;
  }
  // Moonlight lifts a night scene a little.
  return {
    ...grade,
    brightness: Math.min(1, grade.brightness + 0.6 * state.moon.intensity),
  };
}

const css = (color: readonly number[], alpha: number) =>
  `rgb(${color.map((c) => String(Math.round(c * 255))).join(" ")} / ${alpha.toFixed(2)})`;

/** CSS custom properties for the landscape layers. */
export function landscapeStyle(state: LightingState): Record<string, string> {
  const grade = gradeFor(state);
  // A warm glow toward the Sun while it is low, a cool wash at night.
  const low = 1 - Math.min(1, Math.abs(state.sun.altitude) / 12);
  const angle = state.sun.u < 0.5 ? 110 : 250;
  const glow =
    low > 0
      ? `linear-gradient(${String(angle)}deg, ${css(state.sky.horizon, 0.45 * low)}, ${css(state.sky.zenith, 0.15 * low)} 65%, transparent)`
      : `linear-gradient(${css(state.sky.zenith, 0.45)}, ${css(state.sky.zenith, 0.15)})`;
  return {
    "--sky-grade": `brightness(${grade.brightness.toFixed(3)}) saturate(${grade.saturate.toFixed(3)}) sepia(${grade.sepia.toFixed(3)})`,
    "--sky-glow": state.sun.altitude > 12 ? "none" : glow,
  };
}

/** The painted far ridgeline, as a fraction of the viewport height from the top. */
export const HORIZON = 0.46;

/** Screen position of a body, as fractions of the viewport. */
export function skyPoint(body: { u: number; altitude: number }): {
  x: number;
  y: number;
} {
  // Altitude runs from the horizon to the top edge at 90 degrees; the
  // horizontal fraction leaves room at the edges for the disc.
  return {
    x: 0.04 + 0.92 * body.u,
    y: HORIZON * (1 - Math.max(-10, body.altitude) / 90),
  };
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
