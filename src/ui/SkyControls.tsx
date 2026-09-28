/**
 * Sky controls in the top bar: a bookmark list (Live and the developer
 * previews) and a time-of-day slider. Choosing a bookmark sets the slider,
 * date, and place to match; moving the slider keeps the date and place and
 * shows a custom time, which the bookmark list reports as such.
 */
import { useState } from "react";
import type { EnvironmentJson } from "../api/types.ts";
import type { Place } from "../environment/astronomy.ts";
import {
  instantOfLocalTime,
  localTimeOfDay,
} from "../environment/environment.ts";
import { BLUE_RIDGE, BLUE_RIDGE_ZONE } from "../environment/overrides.ts";
import {
  SKY_BOOKMARKS,
  bookmarkSetting,
  type Sky,
  type SkySetting,
} from "./sky.ts";

const MINUTES_PER_DAY = 24 * 60;

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function SkyControls({
  setting,
  sky,
  environment,
  onChange,
}: {
  setting: SkySetting;
  sky: Sky | null;
  environment: EnvironmentJson | null;
  onChange: (next: SkySetting) => void;
}) {
  const [today] = useState(
    () => localTimeOfDay(new Date(), BLUE_RIDGE_ZONE).date,
  );
  // What the slider moves through: the shown sky's day and place. With no
  // place configured, live is the plain noon sky; the slider then shows noon
  // today over the Blue Ridge, the place the previews use.
  const shown: { place: Place; timeZone: string } = sky
    ? { place: sky.snapshot.place, timeZone: sky.snapshot.timeZone }
    : { place: BLUE_RIDGE, timeZone: BLUE_RIDGE_ZONE };
  const local = sky
    ? localTimeOfDay(sky.snapshot.time, sky.snapshot.timeZone)
    : { date: today, minutes: 12 * 60 };
  const bookmark =
    setting.mode === "live" ? "live" : (setting.bookmark ?? "custom");

  return (
    <>
      <label className="preview-control">
        Sky
        <select
          aria-label="Sky"
          value={bookmark}
          onChange={(event) => {
            onChange(bookmarkSetting(event.target.value));
          }}
        >
          {SKY_BOOKMARKS.map(({ value, label }) => (
            <option key={value} value={value}>
              {value === "live" && !environment
                ? "Live · no location configured"
                : label}
            </option>
          ))}
          {bookmark === "custom" && (
            <option value="custom" disabled>
              Custom time
            </option>
          )}
        </select>
      </label>
      <label className="preview-control time-control">
        Time
        <input
          type="range"
          aria-label="Time of day"
          aria-valuetext={`${clock(local.minutes)} on ${local.date}`}
          min={0}
          max={MINUTES_PER_DAY - 1}
          step={1}
          value={local.minutes}
          onChange={(event) => {
            onChange({
              mode: "fixed",
              time: instantOfLocalTime(
                local.date,
                Number(event.target.value),
                shown.timeZone,
              ).getTime(),
              place: shown.place,
              timeZone: shown.timeZone,
              bookmark: null,
            });
          }}
        />
        <output className="time-readout">{clock(local.minutes)}</output>
      </label>
    </>
  );
}
