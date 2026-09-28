import { describe, expect, it } from "vitest";
import {
  localTimeOfDay,
  loopAdvance,
} from "../../src/environment/environment.ts";

/** The loop plays a day in 30 seconds (src/ui/sky.ts LOOP_DAY_MS). */
const LOOP_DAY_MS = 30_000;

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("loopAdvance", () => {
  it("moves on within the day", () => {
    expect(loopAdvance(at("2024-06-20T10:30Z"), 3_600_000, NY)).toBe(
      at("2024-06-20T11:30Z"),
    );
  });

  it("wraps at local midnight to the start of the same local day", () => {
    // 23:30 EDT plus one hour is 00:30 on the same local date.
    const next = loopAdvance(at("2024-06-21T03:30Z"), 3_600_000, NY);
    expect(localTimeOfDay(new Date(next), NY)).toEqual({
      date: "2024-06-20",
      minutes: 30,
    });
  });

  it("replays a 25-hour daylight-saving day whole", () => {
    // 2024-11-03 in New York is 25 hours long.
    const start = at("2024-11-03T04:00Z"); // local midnight, EDT
    expect(loopAdvance(start, 24 * 3_600_000, NY)).toBe(start + 24 * 3_600_000);
    expect(loopAdvance(start, 25 * 3_600_000, NY)).toBe(start);
  });

  it("plays one day per loop period at 48 minutes per second", () => {
    const rate = (24 * 3_600_000) / LOOP_DAY_MS;
    expect(rate * 1000).toBe(48 * 60_000);
  });
});
