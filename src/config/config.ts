/**
 * Versioned configuration (roadmap section 6). Validation is strict: unknown
 * keys, wrong types, out-of-range numbers, bad time zones, unsafe URLs, and
 * duplicate IDs are all errors, reported together with a JSON Pointer and a
 * line/column so the user can fix everything in one pass.
 */
import { BLACKSBURG, BLACKSBURG_ZONE } from "../environment/overrides.ts";
import { isAbsolute, resolve } from "node:path";
import {
  WEEKDAYS,
  isValidTimeZone,
  type Weekday,
} from "../core/business-days.ts";
import {
  JsonSyntaxError,
  parseJsonWithPositions,
  pointerToken,
  type Position,
} from "./json-positions.ts";

/** Default `webhooks.secretEnv`. */
export const DEFAULT_SECRET_ENV = "GIT_FLOWER_GARDEN_WEBHOOK_SECRET";
/** The default under the project's former name, still read as a fallback. */
export const LEGACY_SECRET_ENV = "GIT_GARDEN_WEBHOOK_SECRET";

export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;
export const URL_SCHEMES = ["https", "http", "ssh", "git", "file"] as const;
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" for a github.com URL (https, ssh, or scp-like), else undefined. */
export function githubFromUrl(url: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url,
    );
  const repo = match ? `${match[1] ?? ""}/${match[2] ?? ""}` : undefined;
  return repo !== undefined && GITHUB_REPO.test(repo) ? repo : undefined;
}

export interface RepositoryConfig {
  id: string;
  label: string;
  /** Absolute path (resolved against the config file's directory). */
  path?: string;
  url?: string;
  /** Remotes of a local repository to monitor through the app-owned cache. */
  remotes: string[];
  /** GitHub repository ("owner/name") whose push events trigger a fetch (P1-F). */
  github?: string;
}

export interface Config {
  version: typeof CONFIG_VERSION;
  server: { host: (typeof LOOPBACK_HOSTS)[number]; port: number };
  history: {
    businessDays: number;
    weekdays: Weekday[];
    timeZone: string;
    /** Show only this many of the newest recent commits; null shows them all. */
    maxRecentCommits: number | null;
  };
  monitor: {
    localReconcileSeconds: number;
    remotePollSeconds: number;
    maxConcurrentFetches: number;
    fetchTimeoutSeconds: number;
  };
  display: { renderer: "technical"; reducedMotion: boolean };
  repositories: RepositoryConfig[];
  /** Real-time sky (ADR 0018). Computed offline; nothing leaves the machine. */
  environment: EnvironmentConfig;
  webhooks: {
    enabled: boolean;
    /** Loopback address for a user-managed tunnel or reverse proxy. */
    host: (typeof LOOPBACK_HOSTS)[number];
    port: number;
    /** Name of the environment variable holding the webhook secret. */
    secretEnv: string;
    /** Poll interval for webhook-covered remotes while events arrive (a safety net). */
    safetyPollSeconds: number;
  };
}

export type EnvironmentConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Degrees north, -90..90; east, -180..180; meters above sea level. */
      place: { latitude: number; longitude: number; elevationMeters: number };
      /** Local time shown with the sky; defaults to history.timeZone. */
      timeZone: string;
    };

export interface ConfigError {
  /** JSON Pointer to the offending value ("" for the whole document). */
  pointer: string;
  position?: Position;
  message: string;
}

export type ConfigResult =
  { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

/** The system time zone, used when the config does not name one. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Where the sky is computed when no place is configured. */
export const DEFAULT_PLACE = { ...BLACKSBURG, timeZone: BLACKSBURG_ZONE };

export const DEFAULTS = {
  server: { host: "127.0.0.1", port: 4783 },
  history: {
    businessDays: 2,
    weekdays: ["mon", "tue", "wed", "thu", "fri"] as Weekday[],
  },
  monitor: {
    localReconcileSeconds: 5,
    remotePollSeconds: 60,
    maxConcurrentFetches: 2,
    fetchTimeoutSeconds: 120,
  },
  display: { renderer: "technical", reducedMotion: false },
  environment: {
    enabled: true,
    place: {
      latitude: DEFAULT_PLACE.latitude,
      longitude: DEFAULT_PLACE.longitude,
      elevationMeters: DEFAULT_PLACE.elevationMeters,
    },
    timeZone: DEFAULT_PLACE.timeZone,
  },
} as const;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a remote URL. Accepts https/http/ssh/git/file URLs and scp-like
 * `user@host:path`. Rejects command-running transports (`ext::`, `fd::`),
 * leading dashes, and inline passwords. Returns an error message or null.
 */
export function checkRemoteUrl(url: string): string | null {
  if (url.length === 0) return "must not be empty";
  if (url.startsWith("-")) return "must not start with '-'";
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) {
    return "transport helpers (such as ext:: or fd::) are not allowed";
  }
  if (/[\s\0]/.test(url))
    return "must not contain whitespace or control characters";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!(URL_SCHEMES as readonly string[]).includes(scheme)) {
      return `scheme "${scheme}" is not supported; use ${URL_SCHEMES.join(", ")}`;
    }
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
    const at = authority.lastIndexOf("@");
    if (at !== -1 && authority.slice(0, at).includes(":")) {
      return "must not contain a password; use a credential helper or SSH agent";
    }
    return null;
  }
  // scp-like syntax: [user@]host:path (no scheme, a colon before any slash).
  if (
    /^([^@/:]+@)?[^/:]+:[^/]/.test(url) ||
    /^([^@/:]+@)?[^/:]+:\//.test(url)
  ) {
    return null;
  }
  return "must be a URL (https://, ssh://, git://, file://) or user@host:path";
}

export function validateConfig(
  value: unknown,
  configDir: string,
  positions: ReadonlyMap<string, Position> = new Map(),
): ConfigResult {
  const errors: ConfigError[] = [];
  const err = (pointer: string, message: string): void => {
    // A missing key has no position of its own; point at the nearest enclosing value.
    let located = pointer;
    while (!positions.has(located) && located !== "") {
      located = located.slice(0, located.lastIndexOf("/"));
    }
    const position = positions.get(located);
    errors.push(
      position ? { pointer, position, message } : { pointer, message },
    );
  };
  const at = (pointer: string, key: string | number): string =>
    `${pointer}/${pointerToken(key)}`;

  const object = (
    pointer: string,
    v: unknown,
    allowed: readonly string[],
  ): Obj | undefined => {
    if (!isObject(v)) {
      err(pointer, "must be an object");
      return undefined;
    }
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key))
        err(
          at(pointer, key),
          `unknown key "${key}"; allowed: ${allowed.join(", ")}`,
        );
    }
    return v;
  };
  const integer = (
    pointer: string,
    v: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      err(pointer, `must be an integer from ${String(min)} to ${String(max)}`);
      return fallback;
    }
    return v;
  };
  const boolean = (pointer: string, v: unknown, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") {
      err(pointer, "must be true or false");
      return fallback;
    }
    return v;
  };
  const section = (root: Obj, key: string, allowed: readonly string[]): Obj => {
    const v = root[key];
    if (v === undefined) return {};
    return object(at("", key), v, allowed) ?? {};
  };

  const root = object("", value, [
    "$schema",
    "version",
    "server",
    "history",
    "monitor",
    "display",
    "repositories",
    "environment",
    "webhooks",
  ]);
  if (!root) return { ok: false, errors };

  if (root.version !== CONFIG_VERSION) {
    err(
      "/version",
      root.version === undefined
        ? `is required and must be ${String(CONFIG_VERSION)}`
        : `unsupported version ${JSON.stringify(root.version)}; this git-flower-garden reads version ${String(CONFIG_VERSION)}`,
    );
  }
  if (root.$schema !== undefined && typeof root.$schema !== "string")
    err("/$schema", "must be a string");

  const server = section(root, "server", ["host", "port"]);
  let host: Config["server"]["host"] = DEFAULTS.server.host;
  if (server.host !== undefined) {
    if (
      typeof server.host === "string" &&
      (LOOPBACK_HOSTS as readonly string[]).includes(server.host)
    ) {
      host = server.host as Config["server"]["host"];
    } else {
      err(
        "/server/host",
        `must be a loopback address (${LOOPBACK_HOSTS.join(", ")}); serving on a network needs authentication that does not exist yet`,
      );
    }
  }
  const port = integer(
    "/server/port",
    server.port,
    1,
    65535,
    DEFAULTS.server.port,
  );

  const history = section(root, "history", [
    "businessDays",
    "weekdays",
    "timeZone",
    "maxRecentCommits",
  ]);
  const businessDays = integer(
    "/history/businessDays",
    history.businessDays,
    1,
    366,
    DEFAULTS.history.businessDays,
  );
  let weekdays: Weekday[] = [...DEFAULTS.history.weekdays];
  if (history.weekdays !== undefined) {
    if (!Array.isArray(history.weekdays) || history.weekdays.length === 0) {
      err(
        "/history/weekdays",
        `must be a non-empty array of ${WEEKDAYS.join(", ")}`,
      );
    } else {
      const seen = new Set<string>();
      history.weekdays.forEach((day: unknown, i) => {
        const p = at("/history/weekdays", i);
        if (
          typeof day !== "string" ||
          !(WEEKDAYS as readonly string[]).includes(day)
        )
          err(p, `must be one of ${WEEKDAYS.join(", ")}`);
        else if (seen.has(day)) err(p, `duplicate weekday "${day}"`);
        else seen.add(day);
      });
      weekdays = [...seen] as Weekday[];
    }
  }
  let timeZone = systemTimeZone();
  if (history.timeZone !== undefined) {
    if (
      typeof history.timeZone !== "string" ||
      !isValidTimeZone(history.timeZone)
    ) {
      err(
        "/history/timeZone",
        "must be an IANA time zone such as America/New_York",
      );
    } else {
      timeZone = history.timeZone;
    }
  }

  const maxRecentCommits =
    history.maxRecentCommits === undefined
      ? null
      : integer(
          "/history/maxRecentCommits",
          history.maxRecentCommits,
          1,
          100_000,
          1,
        );

  const monitor = section(root, "monitor", [
    "localReconcileSeconds",
    "remotePollSeconds",
    "maxConcurrentFetches",
    "fetchTimeoutSeconds",
  ]);
  const monitorValues: Config["monitor"] = {
    localReconcileSeconds: integer(
      "/monitor/localReconcileSeconds",
      monitor.localReconcileSeconds,
      1,
      3600,
      DEFAULTS.monitor.localReconcileSeconds,
    ),
    remotePollSeconds: integer(
      "/monitor/remotePollSeconds",
      monitor.remotePollSeconds,
      10,
      86400,
      DEFAULTS.monitor.remotePollSeconds,
    ),
    maxConcurrentFetches: integer(
      "/monitor/maxConcurrentFetches",
      monitor.maxConcurrentFetches,
      1,
      16,
      DEFAULTS.monitor.maxConcurrentFetches,
    ),
    fetchTimeoutSeconds: integer(
      "/monitor/fetchTimeoutSeconds",
      monitor.fetchTimeoutSeconds,
      10,
      3600,
      DEFAULTS.monitor.fetchTimeoutSeconds,
    ),
  };
  const display = section(root, "display", ["renderer", "reducedMotion"]);
  const reducedMotion = boolean(
    "/display/reducedMotion",
    display.reducedMotion,
    false,
  );
  if (display.renderer !== undefined && display.renderer !== "technical") {
    err(
      "/display/renderer",
      'must be "technical" (the garden renderer is not available yet)',
    );
  }
  const webhookSection = section(root, "webhooks", [
    "enabled",
    "host",
    "port",
    "secretEnv",
    "safetyPollSeconds",
  ]);
  const webhooksEnabled = boolean(
    "/webhooks/enabled",
    webhookSection.enabled,
    false,
  );
  let webhookHost: Config["webhooks"]["host"] = "127.0.0.1";
  if (webhookSection.host !== undefined) {
    if (
      typeof webhookSection.host === "string" &&
      (LOOPBACK_HOSTS as readonly string[]).includes(webhookSection.host)
    ) {
      webhookHost = webhookSection.host as Config["webhooks"]["host"];
    } else {
      err(
        "/webhooks/host",
        "must be a loopback address; expose the receiver through a tunnel or reverse proxy you run",
      );
    }
  }
  const webhookPort = integer(
    "/webhooks/port",
    webhookSection.port,
    1,
    65535,
    4785,
  );
  let secretEnv = DEFAULT_SECRET_ENV;
  if (webhookSection.secretEnv !== undefined) {
    if (
      typeof webhookSection.secretEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(webhookSection.secretEnv)
    ) {
      err(
        "/webhooks/secretEnv",
        "must be an environment variable name; the secret itself never goes in this file",
      );
    } else {
      secretEnv = webhookSection.secretEnv;
    }
  }
  const safetyPollSeconds = integer(
    "/webhooks/safetyPollSeconds",
    webhookSection.safetyPollSeconds,
    60,
    86400,
    300,
  );
  const environment = section(root, "environment", [
    "enabled",
    "latitude",
    "longitude",
    "elevationMeters",
    "timeZone",
  ]);
  const environmentEnabled = boolean(
    "/environment/enabled",
    environment.enabled,
    true,
  );
  // With neither coordinate given, the sky is Blacksburg's (maintainer
  // choice); there is no automatic location lookup. Given one, give both.
  const placeGiven =
    environment.latitude !== undefined || environment.longitude !== undefined;
  // When the sky is off, the place is unused and may be incomplete.
  const pair = (fallback: number) =>
    placeGiven && environmentEnabled ? null : fallback;
  const coordinate = (
    key: string,
    min: number,
    max: number,
    fallback: number | null,
  ): number => {
    const v = environment[key];
    const pointer = at("/environment", key);
    if (v === undefined) {
      if (fallback !== null) return fallback;
      err(pointer, "is required with the other coordinate");
      return 0;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      err(pointer, `must be a number from ${String(min)} to ${String(max)}`);
      return 0;
    }
    return v;
  };
  const latitude = coordinate(
    "latitude",
    -90,
    90,
    pair(DEFAULT_PLACE.latitude),
  );
  const longitude = coordinate(
    "longitude",
    -180,
    180,
    pair(DEFAULT_PLACE.longitude),
  );
  const elevationMeters = coordinate(
    "elevationMeters",
    -500,
    9000,
    placeGiven ? 0 : (DEFAULT_PLACE.elevationMeters ?? 0),
  );
  // The default place's sky shows its own local time.
  let environmentTimeZone = placeGiven ? timeZone : DEFAULT_PLACE.timeZone;
  if (environment.timeZone !== undefined) {
    if (
      typeof environment.timeZone !== "string" ||
      !isValidTimeZone(environment.timeZone)
    )
      err(
        "/environment/timeZone",
        "must be an IANA time zone such as America/New_York",
      );
    else environmentTimeZone = environment.timeZone;
  }
  const environmentConfig: EnvironmentConfig = environmentEnabled
    ? {
        enabled: true,
        place: { latitude, longitude, elevationMeters },
        timeZone: environmentTimeZone,
      }
    : { enabled: false };

  const repositories: RepositoryConfig[] = [];
  if (root.repositories === undefined) {
    err("/repositories", "is required (use [] to start with no repositories)");
  } else if (!Array.isArray(root.repositories)) {
    err("/repositories", "must be an array");
  } else {
    const ids = new Map<string, number>();
    root.repositories.forEach((entry: unknown, i) => {
      const p = at("/repositories", i);
      const repo = object(p, entry, [
        "id",
        "label",
        "path",
        "url",
        "remotes",
        "github",
      ]);
      if (!repo) return;
      const id = repo.id;
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        err(
          `${p}/id`,
          "is required: 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
        );
      } else if (ids.has(id)) {
        err(
          `${p}/id`,
          `duplicate id "${id}" (also used by /repositories/${String(ids.get(id))})`,
        );
      } else {
        ids.set(id, i);
      }
      if (
        repo.label !== undefined &&
        (typeof repo.label !== "string" ||
          repo.label.trim() === "" ||
          repo.label.length > 200)
      ) {
        err(
          `${p}/label`,
          "must be a non-empty string of at most 200 characters",
        );
      }
      const hasPath = repo.path !== undefined;
      const hasUrl = repo.url !== undefined;
      if (hasPath === hasUrl)
        err(p, 'must have exactly one of "path" or "url"');
      let path: string | undefined;
      if (hasPath) {
        if (
          typeof repo.path !== "string" ||
          repo.path.trim() === "" ||
          repo.path.includes("\0")
        ) {
          err(`${p}/path`, "must be a non-empty path");
        } else {
          path = isAbsolute(repo.path)
            ? resolve(repo.path)
            : resolve(configDir, repo.path);
        }
      }
      let url: string | undefined;
      if (hasUrl) {
        const problem =
          typeof repo.url === "string"
            ? checkRemoteUrl(repo.url)
            : "must be a string";
        if (problem) err(`${p}/url`, problem);
        else url = repo.url as string;
      }
      let remotes: string[] = [];
      if (repo.remotes !== undefined) {
        if (!hasPath)
          err(`${p}/remotes`, 'applies only to a local "path" repository');
        if (!Array.isArray(repo.remotes)) {
          err(`${p}/remotes`, "must be an array of remote names");
        } else {
          repo.remotes.forEach((name: unknown, k) => {
            if (
              typeof name !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
              name.includes("..")
            ) {
              err(
                at(`${p}/remotes`, k),
                "must be a remote name such as origin",
              );
            }
          });
          remotes = [
            ...new Set(
              repo.remotes.filter((n): n is string => typeof n === "string"),
            ),
          ];
        }
      }
      let github: string | undefined;
      if (repo.github !== undefined) {
        if (typeof repo.github !== "string" || !GITHUB_REPO.test(repo.github)) {
          err(
            `${p}/github`,
            'must be a GitHub repository such as "owner/name"',
          );
        } else {
          github = repo.github;
        }
      } else if (url !== undefined) {
        github = githubFromUrl(url);
      }
      if (typeof id === "string") {
        const label =
          typeof repo.label === "string" && repo.label.trim() !== ""
            ? repo.label
            : id;
        repositories.push({
          id,
          label,
          remotes,
          ...(path === undefined ? {} : { path }),
          ...(url === undefined ? {} : { url }),
          ...(github === undefined ? {} : { github }),
        });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      server: { host, port },
      history: { businessDays, weekdays, timeZone, maxRecentCommits },
      monitor: monitorValues,
      display: { renderer: "technical", reducedMotion },
      repositories,
      environment: environmentConfig,
      webhooks: {
        enabled: webhooksEnabled,
        host: webhookHost,
        port: webhookPort,
        secretEnv,
        safetyPollSeconds,
      },
    },
  };
}

/** Parse and validate configuration text. Syntax errors become a single located error. */
export function parseConfig(text: string, configDir: string): ConfigResult {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      errors: [
        {
          pointer: "",
          message: `configuration is larger than ${String(MAX_CONFIG_BYTES)} bytes`,
        },
      ],
    };
  }
  try {
    const parsed = parseJsonWithPositions(text);
    return validateConfig(parsed.value, configDir, parsed.positions);
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return {
        ok: false,
        errors: [
          {
            pointer: "",
            position: error.position,
            message: `invalid JSON: ${error.reason}`,
          },
        ],
      };
    }
    throw error;
  }
}

export function formatConfigError(file: string, e: ConfigError): string {
  const where = e.position
    ? `${file}:${String(e.position.line)}:${String(e.position.column)}`
    : file;
  return `${where}: ${e.pointer === "" ? "" : `${e.pointer} `}${e.message}`;
}
