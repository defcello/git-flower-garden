/**
 * Fetches the weather for the configured place (roadmap P2-D, ADR 0020).
 *
 * Off unless `environment.weather.enabled`. Independent of repository
 * monitoring: it has its own timers, and a failed or slow request changes
 * only the weather shown. The provider's `Expires` header sets the schedule
 * (bounded below and above), unchanged forecasts are revalidated with
 * `If-Modified-Since`, failures back off, and the last forecast is kept in
 * `<cacheRoot>/weather.json` so a restart does not ask again early.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { WeatherJson } from "../api/types.ts";
import type { EnvironmentConfig } from "../config/config.ts";
import {
  metNorwayRequest,
  nextWeatherChange,
  parseMetNorway,
  weatherAt,
  type FetchRecord,
  type Forecast,
} from "../environment/weather.ts";

const MINUTE = 60_000;
/** Never ask sooner than this after a success, whatever `Expires` says. */
export const MIN_INTERVAL_MS = 15 * MINUTE;
/** Ask at least this often, so a long `Expires` cannot freeze the weather. */
export const MAX_INTERVAL_MS = 2 * 60 * MINUTE;
/** First retry after a failure; doubles up to `MAX_BACKOFF_MS`. */
export const FIRST_BACKOFF_MS = 5 * MINUTE;
export const MAX_BACKOFF_MS = 60 * MINUTE;
/** Throttled or refused (429, 403): wait at least this long. */
export const REFUSED_BACKOFF_MS = 60 * MINUTE;
/** Without an `Expires` header, the forecast is current for this long. */
const DEFAULT_EXPIRY_MS = 30 * MINUTE;
const REQUEST_TIMEOUT_MS = 20_000;
/** A compact forecast is about 40 KB. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_FILE = "weather.json";

export interface WeatherServiceOptions {
  /** App-owned cache directory; the forecast is kept in weather.json there. */
  cacheRoot: string;
  /** The application's version, for the User-Agent. */
  version: string;
  /** Called whenever what `status()` returns may have changed. */
  onChange: () => void;
  now?: () => number;
  fetch?: typeof fetch;
  /** Run timers (default true). Tests call `refresh()` themselves. */
  background?: boolean;
  random?: () => number;
}

interface CacheFile {
  version: 1;
  url: string;
  lastModified: string | null;
  fetchedAt: number;
  expiresAt: number;
  body: unknown;
}

type Settings = Extract<
  Extract<EnvironmentConfig, { enabled: true }>["weather"],
  { enabled: true }
>;

export class WeatherService {
  private readonly options: WeatherServiceOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private key: string | null = null;
  private request: { url: string; headers: Record<string, string> } | null =
    null;
  private forecast: Forecast | null = null;
  private record: FetchRecord | null = null;
  private lastModified: string | null = null;
  private attempted = false;
  private failures = 0;
  private diagnostic: string | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  /** The last forecast document, rewritten to the cache on a 304. */
  private cachedBody: unknown = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: WeatherServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Apply the environment configuration. A change of place or settings
   * starts over; anything else leaves the schedule alone.
   */
  async configure(environment: EnvironmentConfig): Promise<void> {
    const request =
      environment.enabled && environment.weather.enabled
        ? metNorwayRequest(
            environment.place,
            this.userAgent(environment.weather),
          )
        : null;
    const key = request ? JSON.stringify(request) : null;
    if (key === this.key) return;
    this.reset();
    this.key = key;
    this.request = request;
    if (!request) {
      this.options.onChange();
      return;
    }
    const generation = this.generation;
    const cached = await this.readCache(request.url);
    if (generation !== this.generation) return;
    if (cached) {
      try {
        this.forecast = parseMetNorway(cached.body);
        this.record = {
          fetchedAt: cached.fetchedAt,
          expiresAt: cached.expiresAt,
        };
        this.lastModified = cached.lastModified;
        this.cachedBody = cached.body;
      } catch {
        // An unreadable cache is ignored; the next fetch replaces it.
      }
    }
    this.options.onChange();
    const due = this.record
      ? Math.max(this.record.fetchedAt + MIN_INTERVAL_MS, this.record.expiresAt)
      : this.now();
    this.schedule(due);
    this.scheduleChange();
  }

  /** The weather for the API; null when weather is off. */
  status(): WeatherJson | null {
    if (!this.request) return null;
    const now = this.now();
    const { state, conditions } = weatherAt(
      this.forecast,
      this.record,
      now,
      this.attempted,
    );
    return {
      state,
      conditions,
      fetchedAt: this.record?.fetchedAt ?? null,
      diagnostic: this.diagnostic,
    };
  }

  /** Fetch now (one request at a time); the next fetch is scheduled after. */
  refresh(): Promise<void> {
    this.inFlight ??= this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stop(): void {
    this.reset();
    this.key = null;
    this.request = null;
  }

  private userAgent(settings: Settings): string {
    const contact = settings.contact ? ` ${settings.contact}` : "";
    return `git-flower-garden/${this.options.version} (+https://github.com/defcello/git-flower-garden)${contact}`;
  }

  private reset(): void {
    this.generation += 1;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.fetchTimer = null;
    this.changeTimer = null;
    this.forecast = null;
    this.record = null;
    this.lastModified = null;
    this.cachedBody = null;
    this.attempted = false;
    this.failures = 0;
    this.diagnostic = null;
  }

  private schedule(at: number): void {
    if (this.options.background === false) return;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(
      () => void this.refresh(),
      Math.max(0, at - this.now()),
    );
    this.fetchTimer.unref();
  }

  /** Publish when the hour turns or the forecast goes stale, without a fetch. */
  private scheduleChange(): void {
    if (this.options.background === false) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    const at = nextWeatherChange(this.forecast, this.record, this.now());
    if (at === null) return;
    this.changeTimer = setTimeout(
      () => {
        this.options.onChange();
        this.scheduleChange();
      },
      // A little after the boundary, so `status()` sees the new side of it.
      Math.max(0, at - this.now()) + 1000,
    );
    this.changeTimer.unref();
  }

  private async fetchOnce(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const generation = this.generation;
    const fetcher = this.options.fetch ?? fetch;
    const headers = { ...request.headers };
    if (this.lastModified && this.forecast)
      headers["If-Modified-Since"] = this.lastModified;
    let next: number;
    try {
      const response = await fetcher(request.url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      if (generation !== this.generation) {
        await response.body?.cancel();
        return;
      }
      const now = this.now();
      const expires = Date.parse(response.headers.get("expires") ?? "");
      const expiresAt = Number.isFinite(expires)
        ? expires
        : now + DEFAULT_EXPIRY_MS;
      if (response.status === 304 && this.forecast) {
        await response.body?.cancel();
        this.record = { fetchedAt: now, expiresAt };
        this.diagnostic = null;
        await this.writeCacheRecord();
      } else if (response.status === 200 || response.status === 203) {
        const body = JSON.parse(await readBounded(response)) as unknown;
        const forecast = parseMetNorway(body);
        if (generation !== this.generation) return;
        this.forecast = forecast;
        this.record = { fetchedAt: now, expiresAt };
        this.lastModified = response.headers.get("last-modified");
        this.diagnostic =
          response.status === 203
            ? "MET Norway marks this forecast API as deprecated; a newer git-flower-garden may be needed."
            : null;
        await this.writeCache(request.url, body);
      } else {
        await response.body?.cancel();
        const refused = response.status === 429 || response.status === 403;
        throw new FetchError(
          refused
            ? `MET Norway refused the request (HTTP ${String(response.status)}); retrying in an hour or more.`
            : `MET Norway answered HTTP ${String(response.status)}.`,
          refused,
        );
      }
      if (generation !== this.generation) return;
      this.attempted = true;
      this.failures = 0;
      next =
        clamp(expiresAt, now + MIN_INTERVAL_MS, now + MAX_INTERVAL_MS) +
        this.random() * MINUTE;
    } catch (error) {
      if (generation !== this.generation) return;
      this.attempted = true;
      this.failures += 1;
      this.diagnostic =
        error instanceof FetchError
          ? error.message
          : `The weather could not be fetched (${describeError(error)}).`;
      const backoff = Math.min(
        FIRST_BACKOFF_MS * 2 ** (this.failures - 1),
        MAX_BACKOFF_MS,
      );
      const floor =
        error instanceof FetchError && error.refused ? REFUSED_BACKOFF_MS : 0;
      next = this.now() + Math.max(backoff, floor) * (1 + this.random() * 0.2);
    }
    this.options.onChange();
    this.schedule(next);
    this.scheduleChange();
  }

  private async readCache(url: string): Promise<CacheFile | null> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.options.cacheRoot, CACHE_FILE), "utf8"),
      ) as Partial<CacheFile> | null;
      if (
        parsed?.version === 1 &&
        parsed.url === url &&
        typeof parsed.fetchedAt === "number" &&
        typeof parsed.expiresAt === "number"
      )
        return parsed as CacheFile;
    } catch {
      // Missing or unreadable: fetch afresh.
    }
    return null;
  }

  private async writeCacheRecord(): Promise<void> {
    if (this.request && this.cachedBody !== null)
      await this.writeCache(this.request.url, this.cachedBody);
  }

  /** Atomically, readable by the user alone: it holds the configured place. */
  private async writeCache(url: string, body: unknown): Promise<void> {
    this.cachedBody = body;
    if (!this.record) return;
    const file: CacheFile = {
      version: 1,
      url,
      lastModified: this.lastModified,
      fetchedAt: this.record.fetchedAt,
      expiresAt: this.record.expiresAt,
      body,
    };
    const dir = this.options.cacheRoot;
    const temp = join(dir, `weather.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(file), { mode: 0o600 });
      if (process.platform !== "win32") await chmod(temp, 0o600);
      await rename(temp, join(dir, CACHE_FILE));
    } catch {
      // The cache only saves a request after a restart; never fail for it.
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

class FetchError extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) {
    super(message);
    this.refused = refused;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "no answer in time";
    // Node's fetch reports the network cause separately.
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (typeof cause?.code === "string") return cause.code;
    return error.message;
  }
  return String(error);
}

/** The body as text, refusing more than `MAX_RESPONSE_BYTES`. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("the forecast was unexpectedly large");
  }
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("the forecast was unexpectedly large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
