/**
 * Developer previews of the sky (roadmap P2-D): fixed instants and places
 * that show one condition each, computed by the same astronomy as the live
 * sky. Snapshots are marked `preview` so they are never taken for live
 * conditions. Each case is checked in tests/environment/lighting.test.ts.
 */
import {
  environmentSnapshot,
  type EnvironmentSnapshot,
} from "./environment.ts";
import type { Place } from "./astronomy.ts";

/** Asheville, North Carolina, in the Blue Ridge. */
const BLUE_RIDGE: Place = {
  latitude: 35.5951,
  longitude: -82.5515,
  elevationMeters: 650,
};
const BLUE_RIDGE_ZONE = "America/New_York";

/** Longyearbyen, Svalbard: midnight Sun in June, polar night in December. */
const SVALBARD: Place = {
  latitude: 78.2232,
  longitude: 15.6267,
  elevationMeters: 10,
};
const SVALBARD_ZONE = "Arctic/Longyearbyen";

/** Dallas, Texas: under totality on 8 April 2024. */
const DALLAS: Place = {
  latitude: 32.7767,
  longitude: -96.797,
  elevationMeters: 140,
};
const DALLAS_ZONE = "America/Chicago";

/** Albuquerque, New Mexico: under the annular eclipse of 14 October 2023. */
const ALBUQUERQUE: Place = {
  latitude: 35.0844,
  longitude: -106.6504,
  elevationMeters: 1619,
};
const ALBUQUERQUE_ZONE = "America/Denver";

interface Preview {
  label: string;
  time: string;
  place: Place;
  timeZone: string;
}

export const PREVIEWS = {
  sunrise: {
    label: "Sunrise",
    time: "2024-06-20T10:30Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  noon: {
    label: "Noon",
    time: "2024-06-20T17:32Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  sunset: {
    label: "Sunset",
    time: "2024-06-21T00:34Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "civil-dusk": {
    label: "Civil dusk",
    time: "2024-06-21T01:09Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  night: {
    label: "Moonless night",
    time: "2024-05-08T05:00Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "new-moon": {
    label: "New moon (daytime)",
    time: "2024-05-07T17:00Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "first-quarter": {
    label: "First quarter moon",
    time: "2024-05-16T02:15Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "full-moon": {
    label: "Full moon",
    time: "2024-05-23T05:06Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "last-quarter": {
    label: "Last quarter moon",
    time: "2024-05-30T08:45Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "daytime-moon": {
    label: "Moon in daylight",
    time: "2024-05-15T20:00Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "polar-day": {
    label: "Midnight sun (Svalbard)",
    time: "2024-06-20T22:00Z",
    place: SVALBARD,
    timeZone: SVALBARD_ZONE,
  },
  "polar-night": {
    label: "Polar night noon (Svalbard)",
    time: "2024-12-21T11:00Z",
    place: SVALBARD,
    timeZone: SVALBARD_ZONE,
  },
  // Eclipses, each at its greatest from the place (astronomy-engine's
  // SearchLocalSolarEclipse and SearchLunarEclipse).
  "solar-eclipse-partial": {
    label: "Partial solar eclipse",
    time: "2024-04-08T19:09:33Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "solar-eclipse-annular": {
    label: "Annular solar eclipse (Albuquerque)",
    time: "2023-10-14T16:36:52Z",
    place: ALBUQUERQUE,
    timeZone: ALBUQUERQUE_ZONE,
  },
  "solar-eclipse-total": {
    label: "Total solar eclipse (Dallas)",
    time: "2024-04-08T18:42:37Z",
    place: DALLAS,
    timeZone: DALLAS_ZONE,
  },
  "lunar-eclipse-partial": {
    label: "Partial lunar eclipse",
    time: "2025-03-14T05:55:00Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
  "lunar-eclipse-total": {
    label: "Total lunar eclipse",
    time: "2025-03-14T06:58:42Z",
    place: BLUE_RIDGE,
    timeZone: BLUE_RIDGE_ZONE,
  },
} as const satisfies Record<string, Preview>;

export type PreviewName = keyof typeof PREVIEWS;

export const PREVIEW_NAMES = Object.keys(PREVIEWS) as PreviewName[];

export function isPreviewName(value: string): value is PreviewName {
  return Object.hasOwn(PREVIEWS, value);
}

export function previewSnapshot(name: PreviewName): EnvironmentSnapshot {
  const preview: Preview = PREVIEWS[name];
  return environmentSnapshot(
    new Date(preview.time),
    preview.place,
    preview.timeZone,
    name,
  );
}
