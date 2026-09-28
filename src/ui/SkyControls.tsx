/**
 * Sky controls in the top bar: a bookmark list (Live and the developer
 * previews) and a time-of-day slider. Choosing a bookmark sets the slider,
 * date, and place to match; moving the slider keeps the date and place and
 * shows a custom time, which the bookmark list reports as such. Loop plays
 * the chosen day round and round, a day every 30 seconds.
 */
import { useState } from "react";
import type { EnvironmentJson } from "../api/types.ts";
import type { Place } from "../environment/astronomy.ts";
import {
  instantOfLocalTime,
  localTimeOfDay,
} from "../environment/environment.ts";
import { BLACKSBURG, BLACKSBURG_ZONE } from "../environment/places.ts";
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
  looping,
  onLoopingChange,
}: {
  setting: SkySetting;
  sky: Sky | null;
  environment: EnvironmentJson | null;
  onChange: (next: SkySetting) => void;
  looping: boolean;
  onLoopingChange: (looping: boolean) => void;
}) {
  const [today] = useState(
    () => localTimeOfDay(new Date(), BLACKSBURG_ZONE).date,
  );
  // What the slider moves through: the shown sky's day and place. With the
  // real sky turned off, live is the plain noon sky; the slider then shows
  // noon today over Blacksburg, the default place.
  const shown: { place: Place; timeZone: string } = sky
    ? { place: sky.snapshot.place, timeZone: sky.snapshot.timeZone }
    : { place: BLACKSBURG, timeZone: BLACKSBURG_ZONE };
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
            const next = bookmarkSetting(event.target.value);
            // The live sky follows the clock; it cannot also loop.
            if (next.mode === "live") onLoopingChange(false);
            onChange(next);
          }}
        >
          {SKY_BOOKMARKS.map(({ value, label }) => (
            <option key={value} value={value}>
              {value === "live" && !environment ? "Live · real sky off" : label}
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
      <label className="preview-control loop-control">
        <input
          type="checkbox"
          checked={looping}
          onChange={(event) => {
            const on = event.target.checked;
            // Looping starts from the time shown, as a custom time.
            if (on && setting.mode === "live")
              onChange({
                mode: "fixed",
                time: instantOfLocalTime(
                  local.date,
                  local.minutes,
                  shown.timeZone,
                ).getTime(),
                place: shown.place,
                timeZone: shown.timeZone,
                bookmark: null,
              });
            onLoopingChange(on);
          }}
        />
        Loop
      </label>
    </>
  );
}
