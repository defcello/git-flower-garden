/**
 * Per-repository app-owned caches (roadmap sections 5.1 and 6).
 *
 *   <cacheRoot>/repositories/<id>/objects.git   bare repository with fetched objects
 *   <cacheRoot>/repositories/<id>/meta.json     last fetch times, written atomically
 *
 * Cleanup is limited to these directories and happens only on explicit request.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryConfig } from "../config/config.ts";
import type { CachedRemote } from "../git/remote-snapshot.ts";

export interface RemoteMeta {
  url: string;
  lastSuccess: number | null;
}

export interface CacheMeta {
  version: 1;
  remotes: Record<string, RemoteMeta>;
}

export function repositoryCacheDir(cacheRoot: string, id: string): string {
  return join(cacheRoot, "repositories", id);
}

export function objectsDir(cacheRoot: string, id: string): string {
  return join(repositoryCacheDir(cacheRoot, id), "objects.git");
}

/**
 * The remotes a source monitors through the cache, with namespace keys that
 * are safe path segments even for remote names containing "/".
 */
export function cachedRemotes(repo: RepositoryConfig): CachedRemote[] {
  if (repo.url !== undefined) return [{ key: "origin", name: "origin" }];
  const used = new Set<string>();
  return repo.remotes.map((name) => {
    const base =
      name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "r") || "r";
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}-${String(i)}`;
    used.add(key);
    return { key, name };
  });
}

export async function readMeta(
  cacheRoot: string,
  id: string,
): Promise<CacheMeta> {
  try {
    const parsed = JSON.parse(
      await readFile(
        join(repositoryCacheDir(cacheRoot, id), "meta.json"),
        "utf8",
      ),
    ) as Partial<CacheMeta> | null;
    if (parsed?.version === 1 && typeof parsed.remotes === "object") {
      return parsed as CacheMeta;
    }
  } catch {
    // Missing or unreadable metadata: treat the cache as never fetched.
  }
  return { version: 1, remotes: {} };
}

/** Write metadata atomically: a crash leaves the old file or the new one, never half of one. */
export async function writeMeta(
  cacheRoot: string,
  id: string,
  meta: CacheMeta,
): Promise<void> {
  const dir = repositoryCacheDir(cacheRoot, id);
  const target = join(dir, "meta.json");
  const temp = join(dir, `meta.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`);
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function removeRepositoryCache(
  cacheRoot: string,
  id: string,
): Promise<void> {
  await rm(repositoryCacheDir(cacheRoot, id), {
    recursive: true,
    force: true,
    maxRetries: 5,
  });
}
