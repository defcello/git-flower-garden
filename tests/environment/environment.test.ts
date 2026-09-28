import { describe, expect, it } from "vitest";
import {
  instantOfLocalTime,
  localTimeOfDay,
} from "../../src/environment/environment.ts";

describe("local time of day", () => {
  it("reads the local date and minutes in a zone", () => {
    expect(
      localTimeOfDay(new Date("2024-06-20T10:30Z"), "America/New_York"),
    ).toEqual({ date: "2024-06-20", minutes: 6 * 60 + 30 });
    // Late evening in New York is already tomorrow in UTC.
    expect(
      localTimeOfDay(new Date("2024-06-21T03:15Z"), "America/New_York"),
    ).toEqual({ date: "2024-06-20", minutes: 23 * 60 + 15 });
    expect(
      localTimeOfDay(new Date("2024-12-21T11:00Z"), "Arctic/Longyearbyen"),
    ).toEqual({ date: "2024-12-21", minutes: 12 * 60 });
  });

  it("finds the instant for a local time, in summer and winter time", () => {
    expect(
      instantOfLocalTime("2024-06-20", 6 * 60 + 30, "America/New_York"),
    ).toEqual(new Date("2024-06-20T10:30Z"));
    expect(
      instantOfLocalTime("2024-12-20", 6 * 60 + 30, "America/New_York"),
    ).toEqual(new Date("2024-12-20T11:30Z"));
    expect(instantOfLocalTime("2024-06-20", 0, "Asia/Kolkata")).toEqual(
      new Date("2024-06-19T18:30Z"),
    );
  });

  it("round-trips every quarter hour of a daylight-saving day", () => {
    // 2024-11-03: New York clocks go from 01:59 EDT back to 01:00 EST.
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const time = instantOfLocalTime(
        "2024-11-03",
        minutes,
        "America/New_York",
      );
      expect(localTimeOfDay(time, "America/New_York")).toEqual({
        date: "2024-11-03",
        minutes,
      });
    }
  });

  it("lands near a time that a spring-forward gap skips", () => {
    // 2024-03-10 02:30 does not exist in New York.
    const time = instantOfLocalTime(
      "2024-03-10",
      2 * 60 + 30,
      "America/New_York",
    );
    const local = localTimeOfDay(time, "America/New_York");
    expect(local.date).toBe("2024-03-10");
    expect(Math.abs(local.minutes - (2 * 60 + 30))).toBeLessThanOrEqual(60);
  });
});
