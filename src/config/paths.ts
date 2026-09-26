/**
 * Per-user locations for configuration and caches (roadmap section 6). Caches
 * hold private repository data and live outside any monitored workspace.
 * Functions take the environment and platform explicitly so they are testable.
 */
import { join } from "node:path";

const APP = "git-garden";

type Env = Readonly<Record<string, string | undefined>>;

function home(env: Env): string {
  const h = env.HOME ?? env.USERPROFILE;
  if (!h)
    throw new Error(
      "Cannot determine the home directory (HOME/USERPROFILE unset)",
    );
  return h;
}

/** Default configuration file when `--config` is not given. */
export function defaultConfigPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home(env), "AppData", "Roaming"),
      APP,
      "config.json",
    );
  }
  if (platform === "darwin") {
    return join(
      home(env),
      "Library",
      "Application Support",
      APP,
      "config.json",
    );
  }
  return join(
    env.XDG_CONFIG_HOME || join(home(env), ".config"),
    APP,
    "config.json",
  );
}

/** Root directory for app-owned caches (remote object caches, metadata). */
export function defaultCacheDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home(env), "AppData", "Local"),
      APP,
      "Cache",
    );
  }
  if (platform === "darwin") return join(home(env), "Library", "Caches", APP);
  return join(env.XDG_CACHE_HOME || join(home(env), ".cache"), APP);
}
