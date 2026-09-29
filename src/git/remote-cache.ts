import { mkdir } from "node:fs/promises";
import { readGit, records } from "./read.ts";
import { runGit } from "./run-git.ts";

/**
 * App-owned bare repositories that hold fetched remote state (ADR 0002).
 * Fetches never run in a user's clone; each remote's branches and tags are
 * kept in their own namespace so identical tag names cannot collide.
 */

/** Transports git-flower-garden will fetch over. `ext::` and `fd::` can run commands. */
export const ALLOWED_PROTOCOLS = [
  "https",
  "http",
  "ssh",
  "git",
  "file",
] as const;

const CACHE_ENV = {
  // Enforced by Git itself for the URL and any redirects or submodules.
  GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS.join(":"),
} as const;

const CACHE_CONFIG = [
  // Housekeeping in the cache happens explicitly, never mid-fetch.
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  // The cache is bare and private; never follow submodules.
  "-c",
  "fetch.recurseSubmodules=false",
];

/** A remote defined only in one fetch's environment (see fetchIntoCache). */
const FETCH_REMOTE = "garden-fetch";

/**
 * Environment that defines FETCH_REMOTE's URL, after any configuration the
 * user already passes through GIT_CONFIG_COUNT. Other users on the machine
 * can read a process's command line, but not its environment, so a URL with
 * a token in it never appears in a process listing.
 */
export function fetchRemoteEnv(
  url: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${String(n)}`]: `remote.${FETCH_REMOTE}.url`,
    [`GIT_CONFIG_VALUE_${String(n)}`]: url,
  };
}

/** Namespace for one remote inside a cache: `refs/garden/<key>/{heads,tags}/…`. */
export function cacheNamespace(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || key.includes("..")) {
    throw new Error(`Invalid cache key: ${key}`);
  }
  return `refs/garden/${key}`;
}

export async function ensureCache(cacheDir: string): Promise<void> {
  // Private repository data: folders created here are the user's alone.
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await runGit(["init", "--quiet", "--bare", cacheDir], {
    cwd: cacheDir,
    env: CACHE_ENV,
  });
}

export interface FetchResult {
  /** Full cache ref name -> commit or tag object ID, after the fetch. */
  refs: Map<string, string>;
}

/**
 * Fetch every branch and tag from `url` into the cache under `key`'s
 * namespace, forcing moved refs and pruning deleted ones. Uses the user's own
 * credential helpers and SSH agent; never prompts.
 */
export async function fetchIntoCache(
  cacheDir: string,
  key: string,
  url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchResult> {
  const ns = cacheNamespace(key);
  await runGit(
    [
      ...CACHE_CONFIG,
      "fetch",
      "--quiet",
      "--no-tags",
      "--prune",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--end-of-options",
      // The URL itself goes through the environment, never the command line.
      FETCH_REMOTE,
      `+refs/heads/*:${ns}/heads/*`,
      `+refs/tags/*:${ns}/tags/*`,
    ],
    {
      cwd: cacheDir,
      env: { ...CACHE_ENV, ...fetchRemoteEnv(url) },
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { refs: await readCacheRefs(cacheDir, key) };
}

export async function readCacheRefs(
  cacheDir: string,
  key: string,
): Promise<Map<string, string>> {
  const out = await readGit(
    [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `${cacheNamespace(key)}/`,
    ],
    { cwd: cacheDir },
  );
  return new Map(
    records(out, "\n").map((line) => {
      const space = line.indexOf(" ");
      return [line.slice(0, space), line.slice(space + 1)] as const;
    }),
  );
}

/**
 * The fetch URL of a user's configured remote, with `insteadOf` rewriting
 * applied exactly as the user's own `git fetch` would. Contacts no network.
 */
export async function remoteUrl(
  repoPath: string,
  remote: string,
): Promise<string> {
  const out = await readGit(
    ["ls-remote", "--get-url", "--end-of-options", remote],
    {
      cwd: repoPath,
    },
  );
  const url = out.trim();
  // For an unknown remote, Git echoes the name back as if it were a URL.
  if (url === remote) {
    const known = records(await readGit(["remote"], { cwd: repoPath }), "\n");
    if (!known.includes(remote)) throw new Error(`No remote named ${remote}`);
  }
  return url;
}
