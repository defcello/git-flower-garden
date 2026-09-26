/*
 * P0-B fetch-isolation proof: an app-owned cache sees remote changes while the
 * user's clone (refs, index, working files, config, everything under .git)
 * stays byte-for-byte unchanged. Cache contents are checked against
 * `git ls-remote`, a separate view of the remote's current state.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cacheNamespace,
  ensureCache,
  fetchIntoCache,
  readCacheRefs,
  remoteUrl,
} from "../../src/git/remote-cache.ts";
import { readRefs } from "../../src/git/refs.ts";
import { GitError } from "../../src/git/run-git.ts";
import { buildFixture, fixtureGit } from "../fixtures/builder.ts";
import { forkMerge } from "../fixtures/demo.ts";
import { snapshotTree } from "../helpers/snapshot.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

let root: string;
let remote: string; // bare "server"
let user: string; // the user's clone, which must never change
let teammate: string; // another clone that pushes changes

async function remoteState(): Promise<Map<string, string>> {
  const out = await fixtureGit(root, ["ls-remote", remote]);
  const refs = new Map<string, string>();
  for (const line of out.trim().split("\n")) {
    const [oid, name] = line.split("\t") as [string, string];
    if (
      name.startsWith("refs/heads/") ||
      (name.startsWith("refs/tags/") && !name.endsWith("^{}"))
    ) {
      refs.set(name, oid);
    }
  }
  return refs;
}

/** Map `refs/garden/<key>/heads/x` back to `refs/heads/x` for comparison. */
function stripNamespace(
  refs: Map<string, string>,
  key: string,
): Map<string, string> {
  const prefix = `${cacheNamespace(key)}/`;
  return new Map(
    [...refs].map(([name, oid]) => [`refs/${name.slice(prefix.length)}`, oid]),
  );
}

async function commitAndPush(
  message: string,
  ...pushArgs: string[]
): Promise<string> {
  await fixtureGit(teammate, [
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  ]);
  await fixtureGit(teammate, ["push", "--quiet", "origin", ...pushArgs]);
  return (await fixtureGit(teammate, ["rev-parse", "HEAD"])).trim();
}

beforeAll(async () => {
  root = await tempDir();
  const seed = await buildFixture(forkMerge, join(root, "seed"));
  remote = join(root, "remote.git");
  user = join(root, "user");
  teammate = join(root, "teammate");
  await fixtureGit(root, ["clone", "--quiet", "--bare", seed.dir, remote]);
  await fixtureGit(root, ["clone", "--quiet", remote, user]);
  await fixtureGit(root, ["clone", "--quiet", remote, teammate]);
});

describe("app-owned remote cache", () => {
  it("sees pushes, new and deleted branches, and moved tags without touching the user's clone", async () => {
    const cache = join(root, "cache", "garden.git");
    await ensureCache(cache);
    const url = await remoteUrl(user, "origin");
    const userBefore = await snapshotTree(user);
    const userRefsBefore = await readRefs(user);

    // Initial fetch mirrors the remote.
    let result = await fetchIntoCache(cache, "origin", url);
    expect(stripNamespace(result.refs, "origin")).toEqual(await remoteState());

    // A teammate pushes: new commit on main, a new branch, a deleted branch,
    // a moved tag (force), and a new annotated tag.
    const newMain = await commitAndPush(
      "Transplant the hydrangea",
      "HEAD:main",
    );
    await fixtureGit(teammate, [
      "push",
      "--quiet",
      "origin",
      "HEAD:refs/heads/topic/new",
    ]);
    await fixtureGit(teammate, [
      "push",
      "--quiet",
      "origin",
      "--delete",
      "trellis",
    ]);
    await fixtureGit(teammate, ["tag", "--force", "v0.1.0", "HEAD"]);
    await fixtureGit(teammate, [
      "tag",
      "-a",
      "-m",
      "Second bloom",
      "v0.2.0",
      "HEAD",
    ]);
    await fixtureGit(teammate, [
      "push",
      "--quiet",
      "--force",
      "origin",
      "v0.1.0",
      "v0.2.0",
    ]);

    result = await fetchIntoCache(cache, "origin", url);
    const expected = await remoteState();
    expect(stripNamespace(result.refs, "origin")).toEqual(expected);
    expect(expected.get("refs/heads/main")).toBe(newMain);
    expect(expected.has("refs/heads/trellis")).toBe(false);
    expect(expected.get("refs/tags/v0.1.0")).toBe(newMain);
    // The cache holds the new commit object itself.
    const type = await fixtureGit(cache, ["cat-file", "-t", newMain]);
    expect(type.trim()).toBe("commit");

    // The user's clone is untouched, including its now-stale tracking refs.
    expect(await snapshotTree(user)).toEqual(userBefore);
    expect(await readRefs(user)).toEqual(userRefsBefore);
    const userMain = userRefsBefore.find(
      (r) => r.name === "refs/remotes/origin/main",
    );
    expect(userMain?.oid).not.toBe(newMain);
  });

  it("keeps identical tag names from different remotes apart", async () => {
    const cache = join(await tempDir(), "garden.git");
    await ensureCache(cache);
    const other = await buildFixture(forkMerge, join(await tempDir(), "other"));
    await fixtureGit(other.dir, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Diverge",
    ]);
    await fixtureGit(other.dir, ["tag", "--force", "v0.1.0", "HEAD"]);

    await fetchIntoCache(cache, "origin", remote);
    await fetchIntoCache(cache, "fork", pathToFileURL(other.dir).href);
    const originTag = (await readCacheRefs(cache, "origin")).get(
      "refs/garden/origin/tags/v0.1.0",
    );
    const forkTag = (await readCacheRefs(cache, "fork")).get(
      "refs/garden/fork/tags/v0.1.0",
    );
    expect(originTag).toBeDefined();
    expect(forkTag).toBeDefined();
    expect(forkTag).not.toBe(originTag);
  });

  it("refuses command-executing transports and malformed cache keys", async () => {
    const cache = join(await tempDir(), "garden.git");
    await ensureCache(cache);
    const marker = join(cache, "pwned");
    const error = await fetchIntoCache(
      cache,
      "evil",
      `ext::sh -c touch% ${marker}`,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr).toMatch(/transport 'ext' not allowed/);
    await expect(access(marker)).rejects.toThrow();
    expect(() => cacheNamespace("../escape")).toThrow(/Invalid cache key/);
    expect(() => cacheNamespace("a/b")).toThrow(/Invalid cache key/);
  });

  it("resolves the fetch URL the user's own git fetch would use", async () => {
    // A separate clone, so the isolation proof above keeps a pristine user repo.
    const clone = join(await tempDir(), "clone");
    await fixtureGit(root, ["clone", "--quiet", remote, clone]);
    await fixtureGit(clone, [
      "config",
      "url.https://example.invalid/.insteadOf",
      "garden:",
    ]);
    await fixtureGit(clone, ["remote", "add", "short", "garden:plants.git"]);
    expect(await remoteUrl(clone, "short")).toBe(
      "https://example.invalid/plants.git",
    );
    await expect(remoteUrl(user, "nope")).rejects.toThrow(
      /No remote named nope/,
    );
  });
});
