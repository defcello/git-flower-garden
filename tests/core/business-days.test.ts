import { describe, expect, it } from "vitest";
import {
  WEEKDAYS,
  historyWindow,
  inWindow,
  localDate,
  nextRecomputeMs,
  startOfLocalDate,
  validateWindowSettings,
  weekdayOf,
  type Weekday,
  type WindowSettings,
} from "../../src/core/business-days.ts";
import { seededRandom } from "../oracle/random-dag.ts";

const WEEK: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const NY = "America/New_York";
const at = (iso: string): number => Date.parse(iso);
const settings = (
  businessDays: number,
  timeZone = NY,
  weekdays: Weekday[] = WEEK,
): WindowSettings => ({
  businessDays,
  weekdays,
  timeZone,
});

describe("roadmap examples (N=2, Monday–Friday)", () => {
  it.each([
    ["Tuesday", "2026-09-22T15:00:00-04:00", "2026-09-21T00:00:00-04:00"],
    ["Monday", "2026-09-21T08:00:00-04:00", "2026-09-18T00:00:00-04:00"],
    ["Saturday", "2026-09-26T12:00:00-04:00", "2026-09-24T00:00:00-04:00"],
    ["Sunday", "2026-09-27T23:59:00-04:00", "2026-09-24T00:00:00-04:00"],
  ])("%s", (_, now, start) => {
    const window = historyWindow(settings(2), at(now));
    expect(new Date(window.startMs).toISOString()).toBe(
      new Date(at(start)).toISOString(),
    );
    expect(window.endMs).toBe(at(now));
  });

  it("N=1 with all seven days is today so far", () => {
    const window = historyWindow(
      settings(1, NY, [...WEEKDAYS]),
      at("2026-09-26T12:00:00-04:00"),
    );
    expect(window.startMs).toBe(at("2026-09-26T00:00:00-04:00"));
    expect(window.businessDates).toEqual(["2026-09-26"]);
  });

  it("includes weekend commits inside the window and excludes older ones", () => {
    const window = historyWindow(settings(2), at("2026-09-21T08:00:00-04:00")); // Monday
    const seconds = (iso: string): number => at(iso) / 1000;
    expect(inWindow(window, seconds("2026-09-19T12:00:00-04:00"))).toBe(true); // Saturday
    expect(inWindow(window, seconds("2026-09-18T00:00:00-04:00"))).toBe(true); // exact start
    expect(inWindow(window, seconds("2026-09-17T23:59:59-04:00"))).toBe(false);
    expect(inWindow(window, seconds("2026-09-21T08:00:01-04:00"))).toBe(false); // future
  });
});

describe("calendar arithmetic across DST and odd offsets", () => {
  it("spans a spring-forward weekend by calendar days, not 24-hour multiples", () => {
    // DST began Sunday 2026-03-08 in New York. Monday 03-09, N=2 -> Friday 03-06 00:00 EST.
    const window = historyWindow(settings(2), at("2026-03-09T09:00:00-04:00"));
    expect(window.startMs).toBe(at("2026-03-06T00:00:00-05:00"));
  });

  it("starts the day at 01:00 where DST skips midnight (America/Santiago)", () => {
    expect(startOfLocalDate("2026-09-06", "America/Santiago")).toBe(
      at("2026-09-06T01:00:00-03:00"),
    );
    const window = historyWindow(
      settings(1, "America/Santiago", [...WEEKDAYS]),
      at("2026-09-06T10:00:00-03:00"),
    );
    expect(window.startMs).toBe(at("2026-09-06T01:00:00-03:00"));
  });

  it("handles quarter-hour and +14 offsets", () => {
    expect(startOfLocalDate("2026-09-21", "Asia/Kathmandu")).toBe(
      at("2026-09-21T00:00:00+05:45"),
    );
    expect(startOfLocalDate("2026-09-21", "Pacific/Kiritimati")).toBe(
      at("2026-09-21T00:00:00+14:00"),
    );
    expect(localDate(at("2026-09-21T10:30:00Z"), "Pacific/Kiritimati")).toBe(
      "2026-09-22",
    );
  });

  it("schedules recomputation at the next local midnight", () => {
    expect(nextRecomputeMs(at("2026-09-21T23:30:00-04:00"), NY)).toBe(
      at("2026-09-22T00:00:00-04:00"),
    );
    expect(
      nextRecomputeMs(at("2026-09-05T20:00:00-04:00"), "America/Santiago"),
    ).toBe(at("2026-09-06T01:00:00-03:00"));
  });
});

describe("validation", () => {
  it.each([
    [{ businessDays: 0 }, /integer >= 1/],
    [{ businessDays: 1.5 }, /integer >= 1/],
    [{ weekdays: [] }, /must not be empty/],
    [{ weekdays: ["mon", "funday"] }, /Unknown weekday: funday/],
    [{ timeZone: "Mars/Olympus_Mons" }, /Invalid time zone/],
    [{ timeZone: "" }, /Invalid time zone/],
  ])("rejects %j", (override, message) => {
    expect(() => {
      validateWindowSettings({ ...settings(2), ...override } as WindowSettings);
    }).toThrow(message);
  });
});

/**
 * Independent oracle: step backward one minute at a time from `now`, reading
 * each minute's local date through Intl, and stop once we leave the Nth
 * distinct business date. The window start is the last minute still inside.
 * No calendar arithmetic is shared with the implementation.
 */
function oracleStart(s: WindowSettings, nowMs: number): number {
  const allowed = new Set(s.weekdays);
  const minute = 60_000;
  let t = Math.floor(nowMs / minute) * minute;
  let earliest = t;
  const business: string[] = [];
  for (;;) {
    const date = localDate(t, s.timeZone);
    if (allowed.has(weekdayOf(date)) && !business.includes(date)) {
      if (business.length === s.businessDays) break;
      business.push(date);
    }
    if (business.length === s.businessDays && date !== business.at(-1)) break;
    earliest = t;
    t -= minute;
  }
  return earliest;
}

describe("agrees with a minute-by-minute oracle", () => {
  const zones = [
    "America/New_York",
    "America/Santiago",
    "Australia/Lord_Howe", // 30-minute DST shift
    "Asia/Kathmandu",
    "Pacific/Chatham",
    "Pacific/Kiritimati",
    "Europe/London",
    "UTC",
  ];
  // Instants near 2026 DST transitions plus arbitrary ones.
  const anchors = [
    "2026-03-08T07:30:00Z",
    "2026-04-05T15:00:00Z",
    "2026-09-06T04:30:00Z",
    "2026-10-25T01:30:00Z",
    "2026-11-01T06:30:00Z",
    "2026-09-26T12:00:00Z",
  ];

  it("across zones, DST dates, N, and weekday sets", () => {
    const random = seededRandom(7);
    let cases = 0;
    for (const zone of zones) {
      for (const anchor of anchors) {
        const nowMs =
          at(anchor) +
          Math.floor(random() * 48 * 3600 * 1000) -
          24 * 3600 * 1000;
        const weekdays = WEEKDAYS.filter(() => random() < 0.7);
        if (weekdays.length < 3) weekdays.push("mon", "wed", "fri");
        const s = settings(1 + Math.floor(random() * 3), zone, [
          ...new Set(weekdays),
        ]);
        expect(
          historyWindow(s, nowMs).startMs,
          `${zone} ${new Date(nowMs).toISOString()} ${JSON.stringify(s)}`,
        ).toBe(oracleStart(s, nowMs));
        cases++;
      }
    }
    expect(cases).toBe(zones.length * anchors.length);
  }, 60_000);
});
