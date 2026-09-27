/**
 * Per-user locations for configuration and caches (roadmap section 6). Caches
 * hold private repository data and live outside any monitored workspace.
 * Functions take the environment and platform explicitly so they are testable.
 */
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const APP = "git-flower-garden";
/** The project's former name. Its folders are moved to APP on first run. */
const LEGACY_APP = "git-garden";

type Env = Readonly<Record<string, string | undefined>>;

function home(env: Env): string {
  const h = env.HOME ?? env.USERPROFILE;
  if (!h)
    throw new Error(
      "Cannot determine the home directory (HOME/USERPROFILE unset)",
    );
  return h;
}

function configPath(app: string, env: Env, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home(env), "AppData", "Roaming"),
      app,
      "config.json",
    );
  }
  if (platform === "darwin") {
    return join(
      home(env),
      "Library",
      "Application Support",
      app,
      "config.json",
    );
  }
  return join(
    env.XDG_CONFIG_HOME || join(home(env), ".config"),
    app,
    "config.json",
  );
}

function cacheDir(app: string, env: Env, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home(env), "AppData", "Local"),
      app,
      "Cache",
    );
  }
  if (platform === "darwin") return join(home(env), "Library", "Caches", app);
  return join(env.XDG_CACHE_HOME || join(home(env), ".cache"), app);
}

/** Default configuration file when `--config` is not given. */
export function defaultConfigPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return configPath(APP, env, platform);
}

/** Root directory for app-owned caches (remote object caches, metadata). */
export function defaultCacheDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return cacheDir(APP, env, platform);
}

/**
 * The app-named folders holding the default configuration and cache, for the
 * current and the former name. On Windows the cache is `<app>\Cache`, so the
 * folder to move is its parent.
 */
function appFolders(
  app: string,
  env: Env,
  platform: NodeJS.Platform,
): { config: string; cache: string } {
  const cache = cacheDir(app, env, platform);
  return {
    config: dirname(configPath(app, env, platform)),
    cache: platform === "win32" ? dirname(cache) : cache,
  };
}

/**
 * Move the per-user folders of the former name (`git-garden`) to the current
 * one, for whichever of configuration and cache are at their defaults. A
 * folder moves only when the new one does not exist yet, so this runs once
 * and never merges or overwrites. Returns one line per folder moved or left
 * behind; a failure is reported, not thrown.
 */
export async function migrateLegacyFolders(
  which: { config: boolean; cache: boolean },
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const from = appFolders(LEGACY_APP, env, platform);
  const to = appFolders(APP, env, platform);
  const notes: string[] = [];
  for (const kind of ["config", "cache"] as const) {
    if (!which[kind] || !existsSync(from[kind]) || existsSync(to[kind]))
      continue;
    try {
      await rename(from[kind], to[kind]);
      notes.push(
        `Moved ${from[kind]} to ${to[kind]} (the project was renamed).`,
      );
    } catch (error) {
      notes.push(
        `Could not move ${from[kind]} to ${to[kind]}: ${(error as Error).message}. Move it by hand.`,
      );
    }
  }
  return notes;
}
