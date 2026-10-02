import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentConfig } from "../../src/config/config.ts";
import {
  MAX_RESPONSE_BYTES,
  WeatherService,
} from "../../src/server/weather.ts";
import { metDocument, SAMPLE_STEPS } from "../helpers/met-norway.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();
const T0 = Date.parse("2026-10-01T04:10:00Z");
const EXPIRES = "Thu, 01 Oct 2026 04:40:00 GMT";
const LAST_MODIFIED = "Thu, 01 Oct 2026 04:09:00 GMT";

const env = (
  weather: Extract<EnvironmentConfig, { enabled: true }>["weather"],
  latitude = 37.2296,
): EnvironmentConfig => ({
  enabled: true,
  place: { latitude, longitude: -80.4139, elevationMeters: 634 },
  timeZone: "America/New_York",
  weather,
});
const WEATHER = {
  enabled: true,
  provider: "met-norway",
  contact: null,
} as const;
const ON = env(WEATHER);

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A provider stand-in answering from a queue of responses. */
function provider(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected request");
    return Promise.resolve(answer());
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const ok =
  (body: unknown = metDocument(SAMPLE_STEPS)) =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { expires: EXPIRES, "last-modified": LAST_MODIFIED },
    });

async function service(answers: (() => Response)[], cacheRoot?: string) {
  let now = T0;
  let changes = 0;
  const p = provider(answers);
  const weather = new WeatherService({
    cacheRoot: cacheRoot ?? (await tempDir()),
    version: "9.9.9",
    onChange: () => {
      changes += 1;
    },
    now: () => now,
    fetch: p.fetch,
    background: false,
    random: () => 0,
  });
  return {
    weather,
    calls: p.calls,
    setNow: (t: number) => {
      now = t;
    },
    changes: () => changes,
  };
}

describe("weather service (ADR 0020)", () => {
  it("is off unless enabled, and then sends nothing", async () => {
    const s = await service([]);
    await s.weather.configure(env({ enabled: false }));
    expect(s.weather.status()).toBeNull();
    await s.weather.configure({ enabled: false });
    await s.weather.refresh();
    expect(s.weather.status()).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it("waits, then shows this hour's forecast, identifying the app", async () => {
    const s = await service([ok()]);
    await s.weather.configure(
      env({ enabled: true, provider: "met-norway", contact: "me@example.com" }),
    );
    expect(s.weather.status()?.state).toBe("waiting");
    await s.weather.refresh();
    expect(s.calls[0]?.url).toContain("lat=37.2296&lon=-80.4139&altitude=634");
    expect(s.calls[0]?.headers["User-Agent"]).toBe(
      "git-flower-garden/9.9.9 (+https://github.com/defcello/git-flower-garden) me@example.com",
    );
    expect(s.weather.status()).toMatchObject({
      state: "fresh",
      fetchedAt: T0,
      diagnostic: null,
      conditions: { validFrom: "2026-10-01T04:00:00.000Z" },
    });
    // The hour turns without a request.
    s.setNow(Date.parse("2026-10-01T05:01:00Z"));
    expect(s.weather.status()?.conditions?.symbol).toBe(
      "lightrainshowers_night",
    );
  });

  it("revalidates with If-Modified-Since and keeps the forecast on 304", async () => {
    const s = await service([
      ok(),
      () =>
        new Response(null, {
          status: 304,
          headers: { expires: "Thu, 01 Oct 2026 05:20:00 GMT" },
        }),
    ]);
    await s.weather.configure(ON);
    await s.weather.refresh();
    s.setNow(T0 + 40 * 60_000);
    await s.weather.refresh();
    expect(s.calls[1]?.headers["If-Modified-Since"]).toBe(LAST_MODIFIED);
    expect(s.weather.status()).toMatchObject({
      state: "fresh",
      fetchedAt: T0 + 40 * 60_000,
    });
  });

  it("goes stale on failures, then unavailable, and recovers", async () => {
    const s = await service([
      ok(),
      () => {
        throw new TypeError("fetch failed", {
          cause: { code: "ENOTFOUND" },
        });
      },
      () => new Response("busy", { status: 429 }),
      ok(),
    ]);
    await s.weather.configure(ON);
    await s.weather.refresh();
    s.setNow(Date.parse("2026-10-01T05:00:00Z"));
    await s.weather.refresh();
    expect(s.weather.status()).toMatchObject({
      state: "stale",
      diagnostic: "The weather could not be fetched (ENOTFOUND).",
    });
    expect(s.weather.status()?.conditions).not.toBeNull();
    await s.weather.refresh();
    expect(s.weather.status()?.diagnostic).toMatch(/refused.*HTTP 429/);
    // Past the sample's last hour: nothing to show, neutral weather.
    s.setNow(Date.parse("2026-10-01T07:00:00Z"));
    expect(s.weather.status()).toMatchObject({
      state: "unavailable",
      conditions: null,
    });
    await s.weather.refresh();
    expect(s.weather.status()?.diagnostic).toBeNull();
  });

  it("says unavailable when the first request fails", async () => {
    const s = await service([() => new Response("down", { status: 500 })]);
    await s.weather.configure(ON);
    await s.weather.refresh();
    expect(s.weather.status()).toMatchObject({
      state: "unavailable",
      conditions: null,
      diagnostic: "MET Norway answered HTTP 500.",
    });
  });

  it("refuses oversized and malformed answers", async () => {
    const big = "x".repeat(MAX_RESPONSE_BYTES + 1);
    const s = await service([
      () => new Response(big, { status: 200 }),
      () => new Response("{}", { status: 200 }),
    ]);
    await s.weather.configure(ON);
    await s.weather.refresh();
    expect(s.weather.status()?.diagnostic).toMatch(/unexpectedly large/);
    await s.weather.refresh();
    expect(s.weather.status()?.diagnostic).toMatch(/not a MET Norway/);
    expect(s.weather.status()?.state).toBe("unavailable");
  });

  it("keeps the forecast across a restart, privately, for the same place only", async () => {
    const cacheRoot = await tempDir();
    const first = await service([ok()], cacheRoot);
    await first.weather.configure(ON);
    await first.weather.refresh();
    if (process.platform !== "win32")
      expect((await stat(join(cacheRoot, "weather.json"))).mode & 0o777).toBe(
        0o600,
      );
    const again = await service([], cacheRoot);
    await again.weather.configure(ON);
    expect(again.weather.status()).toMatchObject({
      state: "fresh",
      fetchedAt: T0,
    });
    const elsewhere = await service([], cacheRoot);
    await elsewhere.weather.configure(env(WEATHER, 40));
    expect(elsewhere.weather.status()?.state).toBe("waiting");
    // A corrupt cache is ignored.
    await writeFile(join(cacheRoot, "weather.json"), "{");
    const corrupt = await service([], cacheRoot);
    await corrupt.weather.configure(ON);
    expect(corrupt.weather.status()?.state).toBe("waiting");
    expect(await readFile(join(cacheRoot, "weather.json"), "utf8")).toBe("{");
  });

  it("starts over when the place changes, and ignores a stale answer", async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const weather = new WeatherService({
      cacheRoot: await tempDir(),
      version: "1",
      onChange: () => undefined,
      now: () => T0,
      fetch: () => pending,
      background: false,
    });
    await weather.configure(ON);
    const inFlight = weather.refresh();
    await weather.configure(env(WEATHER, 40));
    release(ok()());
    await inFlight;
    expect(weather.status()?.state).toBe("waiting");
  });
});
