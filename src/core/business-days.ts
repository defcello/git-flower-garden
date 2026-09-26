/**
 * The recent-history window (roadmap section 4.2, ADR 0004): a continuous
 * lookback from `now` to the start of the Nth most recent business date,
 * counted in the configured IANA time zone. Today counts if it is a business
 * date; non-business dates inside the window are included.
 */

export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WindowSettings {
  businessDays: number;
  weekdays: readonly Weekday[];
  timeZone: string;
}

export interface HistoryWindow {
  /** Inclusive lower bound, milliseconds since the epoch. */
  startMs: number;
  /** The `now` the window was computed for (inclusive upper bound). */
  endMs: number;
  /** Local calendar dates (YYYY-MM-DD) counted as business dates, newest first. */
  businessDates: string[];
  timeZone: string;
}

/** Throws with a readable message when settings cannot define a window. */
export function validateWindowSettings(settings: WindowSettings): void {
  const { businessDays, weekdays, timeZone } = settings;
  if (!Number.isInteger(businessDays) || businessDays < 1) {
    throw new Error(
      `businessDays must be an integer >= 1, got ${String(businessDays)}`,
    );
  }
  if (weekdays.length === 0) throw new Error("weekdays must not be empty");
  for (const day of weekdays) {
    if (!WEEKDAYS.includes(day)) throw new Error(`Unknown weekday: ${day}`);
  }
  if (!isValidTimeZone(timeZone))
    throw new Error(`Invalid time zone: ${timeZone}`);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Compute the window for one captured `now` (milliseconds since the epoch). */
export function historyWindow(
  settings: WindowSettings,
  nowMs: number,
): HistoryWindow {
  validateWindowSettings(settings);
  const allowed = new Set(settings.weekdays);
  const businessDates: string[] = [];
  // Walk calendar dates backward; plain date arithmetic, so DST cannot skew it.
  let date = localDate(nowMs, settings.timeZone);
  while (businessDates.length < settings.businessDays) {
    if (allowed.has(weekdayOf(date))) businessDates.push(date);
    date = addDays(date, -1);
  }
  const oldest = businessDates.at(-1) as string;
  return {
    startMs: startOfLocalDate(oldest, settings.timeZone),
    endMs: nowMs,
    businessDates,
    timeZone: settings.timeZone,
  };
}

/** Membership test for a commit timestamp in seconds. */
export function inWindow(window: HistoryWindow, epochSeconds: number): boolean {
  const ms = epochSeconds * 1000;
  return ms >= window.startMs && ms <= window.endMs;
}

/** The next instant at which a window computed now would change: the next local midnight. */
export function nextRecomputeMs(nowMs: number, timeZone: string): number {
  return startOfLocalDate(addDays(localDate(nowMs, timeZone), 1), timeZone);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(ms: number, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDate(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = parseDate(date);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as Weekday;
}

const QUARTER_HOUR = 15 * 60 * 1000;

/**
 * The first instant whose local date is `date`. Usually local midnight, but
 * where a DST change skips midnight (e.g. America/Santiago) the day starts at
 * 01:00. Coarse 15-minute steps find the first quarter-hour inside the date,
 * then binary search narrows to the exact millisecond.
 */
export function startOfLocalDate(date: string, timeZone: string): number {
  const [y, m, d] = parseDate(date);
  // No offset exceeds ±14h, so the day starts within this span.
  let low = Date.UTC(y, m - 1, d) - 15 * 60 * 60 * 1000;
  const limit = Date.UTC(y, m - 1, d) + 15 * 60 * 60 * 1000;
  while (localDate(low + QUARTER_HOUR, timeZone) < date) {
    low += QUARTER_HOUR;
    if (low > limit)
      throw new Error(`Date ${date} does not occur in ${timeZone}`);
  }
  let high = low + QUARTER_HOUR; // localDate(high) >= date, localDate(low) < date
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDate(mid, timeZone) < date) low = mid;
    else high = mid;
  }
  return high;
}
