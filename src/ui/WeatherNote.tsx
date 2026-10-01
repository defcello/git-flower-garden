/**
 * The weather line of the environment details (roadmap P2-D, ADR 0020):
 * what the provider forecasts for this hour, its source and valid time,
 * and whether it is stale. Shown only with the live sky.
 */
import type { WeatherJson } from "../api/types.ts";
import { describeConditions } from "../environment/weather.ts";

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

export function WeatherNote({
  weather,
  timeZone,
}: {
  weather: WeatherJson;
  timeZone: string;
}) {
  const { state, conditions, fetchedAt, diagnostic } = weather;
  if (state === "waiting")
    return <span className="weather-note">Weather: asking MET Norway…</span>;
  if (!conditions)
    return (
      <span className="weather-note" data-weather-state={state}>
        Weather unavailable{diagnostic ? ` (${diagnostic})` : ""}; the sky shows
        no weather.
      </span>
    );
  const from = clock(Date.parse(conditions.validFrom), timeZone);
  const until = clock(Date.parse(conditions.validUntil), timeZone);
  return (
    <span className="weather-note" data-weather-state={state}>
      {state === "stale" && (
        <strong className="weather-stale">Stale weather: </strong>
      )}
      Forecast {from}–{until}: {describeConditions(conditions)} (a model
      forecast, not observed
      {fetchedAt !== null ? `; fetched ${clock(fetchedAt, timeZone)}` : ""}
      {state === "stale" && diagnostic ? `; ${diagnostic}` : ""}).{" "}
      <a
        className="weather-credit"
        href="https://api.met.no/doc/License"
        target="_blank"
        rel="noopener noreferrer"
      >
        {conditions.provider.attribution}
      </a>
      .
    </span>
  );
}
