# 0020: Weather from MET Norway, opt-in, fetched by the local service

- Status: Accepted (maintainer, 2026-10-01)
- Date: 2026-10-01
- Roadmap: section 10 (P2-D), sections 6 and 13; ADR 0018 delivery step 5
- Related: [ADR 0018](0018-two-tier-scene-renderer.md) (the scene that will
  draw the weather), [ADR 0019](0019-astronomy-engine-review.md) (offline
  astronomy, which weather never replaces)

## Context

P2-D asks for clouds, rain, snow, wind, and rainbows from real conditions,
from a provider evaluated "against licensing, attribution, commercial-use
terms, quotas, geographic coverage, freshness, and offline behavior at
implementation time", without equating an open-source client with
unrestricted use of a hosted service. Git monitoring must not depend on it
(section 3), and nothing may leave the machine without the user asking
(sections 1 and 13).

git-flower-garden is MIT-licensed and runs on each user's own machine, so
each installation is its own client of the provider. Some users will run it
at work, which is commercial use under most terms.

## Options considered

Terms as published on 2026-10-01.

| Provider | Coverage | Data license, commercial use | Limits and etiquette | Key | Verdict |
| --- | --- | --- | --- | --- | --- |
| **MET Norway** Locationforecast 2.0 ([terms](https://api.met.no/doc/TermsOfService)) | Global | CC BY 4.0; commercial use allowed (no Yr name or logo) | 20 requests/s per application; identify with a User-Agent carrying contact details; honor `Expires`, revalidate with `If-Modified-Since`; at most 4 decimals of coordinates; browsers should go through a local proxy | None | **Chosen** |
| Open-Meteo free API ([terms](https://open-meteo.com/en/terms)) | Global | CC BY 4.0, but the free API is for non-commercial use only; commercial use needs a paid plan | 10,000 calls/day | None (free) | Rejected as the default: a user at work would breach its terms without knowing |
| US National Weather Service ([API](https://www.weather.gov/documentation/services-web-api)) | United States only | Public domain, any use | Undisclosed limits; User-Agent required; an API key is planned | None yet | Rejected: not global; a possible second provider later |
| Keyed commercial services | Global | Varies; usually per-user accounts, paid tiers | Quotas per key | Required | Rejected: a weather account must not be needed (section 3) |

MET Norway is the only candidate that is global, free, needs no account,
and allows commercial use. Its etiquette matches what P2-D wants anyway:
caching by `Expires`, revalidation, and a server-side fetcher.

## Decision

1. **Opt-in.** `environment.weather.enabled` is false by default. Enabling
   it sends the configured place (the sky's place, Blacksburg when none is
   configured) to `api.met.no`, rounded to four decimals (about 11 m), with
   altitude in whole meters. The schema description and the user guide say
   so. The weather is off when the sky is off.
2. **Fetched by the local service, never by the browser.** The browser
   receives normalized conditions over the existing API and event stream.
   The page's content security policy is unchanged, and the provider sees
   one client per installation, as its terms ask.
3. **Identification.** The User-Agent is
   `git-flower-garden/<version> (+https://github.com/defcello/git-flower-garden)`,
   plus the optional `environment.weather.contact` (an email or web
   address), so MET Norway can reach the user instead of blocking the app.
   The contact must be printable ASCII on one line (it is a header).
4. **Schedule.** The next request is at the response's `Expires` (about 30
   minutes), but no sooner than 15 minutes and no later than 2 hours after
   a success, plus up to a minute of jitter. Unchanged forecasts are
   revalidated with `If-Modified-Since` (a 304 renews the forecast).
   Failures back off from 5 minutes, doubling to an hour; 429 and 403 wait
   at least an hour. One request at a time, 20 s timeout, no redirects,
   2 MiB response cap.
5. **Cache.** The last forecast, its `Last-Modified`, and its expiry are
   kept in `<cache>/weather.json` (written atomically, mode 0600, since it
   holds the place), so a restart does not ask again early. It is used only
   for the same request (same place, same User-Agent).
6. **What is shown.** The forecast hour containing now: cloud cover,
   fog, thunder, precipitation type (rain, sleet, snow), intensity, showers,
   amount, wind, and temperature, normalized from MET Norway's symbol codes
   and values (`src/environment/weather.ts`). It is always labelled a model
   forecast, not an observation, with its hour, fetch time, and the CC BY
   4.0 credit.
7. **Freshness.**
   - *waiting*: enabled, no forecast yet;
   - *fresh*: within the provider's expiry plus 15 minutes;
   - *stale*: later than that (requests failing); still shown, marked
     "Stale weather", with the reason;
   - *unavailable*: no forecast, or 6 hours since the last success, or the
     forecast no longer covers the hour. The scene then shows neutral
     weather (none), and astronomy carries on, since it is computed offline.
8. **Isolation.** The fetcher has its own timers and state. A failing,
   slow, or refusing provider changes only the weather status;
   `tests/server/operations.test.ts` keeps reading and serving a repository
   while every weather request fails.

## Not decided here

Drawing clouds, rain, snow, wind strength in the sway, and rainbows in both
tiers, with particle caps and presets (ADR 0018 step 5, next), and the
developer weather previews. Rainbows will be an artistic inference from
showers and sunlight, never presented as observed.

## Verification

- `tests/environment/weather.test.ts`: request rounding and identification,
  parsing and normalization (every symbol family, MET Norway's misspelled
  codes, unknown codes), hour selection, the four states and their
  boundaries, and the next state change.
- `tests/server/weather.test.ts`: off sends nothing; waiting to fresh;
  revalidation and 304; stale, refused (429), unavailable, and recovery;
  oversized and malformed answers; the private cache across a restart and
  only for the same place; a reconfiguration discards an answer in flight.
- `tests/config/config.test.ts`: off by default, validation of provider and
  contact (no header injection), schema agreement.
- Manual, 2026-10-01: the service fetched Blacksburg's forecast from
  `api.met.no` (200, `Expires` 31 minutes ahead, 36.9 KB, 56 hourly
  steps), the garden view showed it, and a restart reused the cache
  without a request.

## Consequences

- An external service enters the product, only on request. Offline use is
  unchanged.
- The attribution must stay visible wherever weather is shown, and the
  third-party notices must mention the data license before distribution
  (P2-E).
- MET Norway's terms may change; the provider is one module behind
  normalized conditions, so another (such as the US National Weather
  Service) can be added with its own ADR.

## Maintainer answers (2026-10-01)

1. **Provider and design**: accepted as above (MET Norway, opt-in, fetched
   by the service, stale after expiry plus 15 minutes, neutral after 6
   hours).
2. **Place**: weather follows the sky's place, so without configured
   coordinates it is Blacksburg's, like the sky; coordinates are not
   required to turn weather on.
