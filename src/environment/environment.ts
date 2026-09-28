/**
 * The scene's environment at one instant (ADR 0018): where and when, and the
 * Sun and Moon computed offline from them. Independent of repository refresh;
 * the clock is injected so tests and previews choose the instant.
 */
import { skyBodies, type Place, type SkyBodies } from "./astronomy.ts";

export type { Place } from "./astronomy.ts";

export interface EnvironmentSnapshot {
  time: Date;
  place: Place;
  /** IANA time zone used to show local time. Lighting depends only on `time`. */
  timeZone: string;
  /** Local wall-clock time in `timeZone`, for the environment details. */
  localTime: string;
  sky: SkyBodies;
  /** `preview` marks a developer override, never the live sky. */
  source: "live" | "preview";
  /** Name of the developer preview, when `source` is `preview`. */
  preview?: string;
  /** Reserved for the weather provider (roadmap P2-D); none yet. */
  weather: null;
}

export function formatLocalTime(time: Date, timeZone: string): string {
  // Throws RangeError for an unknown time zone.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(time);
}

/** A local calendar date (`YYYY-MM-DD`) and minutes after local midnight. */
export interface LocalTimeOfDay {
  date: string;
  minutes: number;
}

/** The local date and time of day of `time` in `timeZone`. */
export function localTimeOfDay(time: Date, timeZone: string): LocalTimeOfDay {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The instant when the clocks in `timeZone` show `minutes` after midnight on
 * `date`. In a daylight-saving gap, a nearby instant; in a repeated hour,
 * one of the two.
 */
export function instantOfLocalTime(
  date: string,
  minutes: number,
  timeZone: string,
): Date {
  const asUtc = (local: LocalTimeOfDay) => {
    const [y = 0, m = 1, d = 1] = local.date.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 0, local.minutes);
  };
  const target = asUtc({ date, minutes });
  // Correct by the zone's offset; twice settles on the offset at the result.
  let time = target;
  for (let i = 0; i < 3; i++) {
    const shown = asUtc(localTimeOfDay(new Date(time), timeZone));
    if (shown === target) break;
    time += target - shown;
  }
  return new Date(time);
}

export function environmentSnapshot(
  time: Date,
  place: Place,
  timeZone: string,
  preview?: string,
): EnvironmentSnapshot {
  return {
    time: new Date(time.getTime()),
    place,
    timeZone,
    localTime: formatLocalTime(time, timeZone),
    sky: skyBodies(time, place),
    source: preview === undefined ? "live" : "preview",
    ...(preview === undefined ? {} : { preview }),
    weather: null,
  };
}

export interface EnvironmentOptions {
  place: Place;
  timeZone: string;
  clock?: () => Date;
}

/** A live environment: each snapshot reads the injected clock. */
export function createEnvironment(options: EnvironmentOptions): {
  snapshot(): EnvironmentSnapshot;
} {
  const clock = options.clock ?? (() => new Date());
  // Validate once, up front, rather than on the first frame.
  environmentSnapshot(clock(), options.place, options.timeZone);
  return {
    snapshot: () =>
      environmentSnapshot(clock(), options.place, options.timeZone),
  };
}
