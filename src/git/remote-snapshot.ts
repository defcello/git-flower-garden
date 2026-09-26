/**
 * Snapshots that include remote state from an app-owned cache (roadmap
 * sections 4.1 and 5.1).
 *
 * - Remote-only source: every branch and tag the cache fetched from the URL.
 * - Local source with monitored remotes: the clone's own branches, tags, and
 *   worktrees, plus each monitored remote's *current* branches from the cache.
 *   The clone's tracking refs for those remotes (last fetched by the user) are
 *   dropped so one branch never appears as two "current" versions.
 *
 * Commits from both places are read in the cache with the user's object
 * directory added for this process only (GIT_ALTERNATE_OBJECT_DIRECTORIES).
 * Nothing is written to either repository.
 */
import { join } from "node:path";
import { readRefs, type GitRef, type RefNamespace } from "./refs.ts";
import { cacheNamespace } from "./remote-cache.ts";
import { resolveRepository } from "./repository.ts";
import {
  commitTips,
  missingTips,
  readSnapshot,
  readTopologyTolerant,
  SNAPSHOT_SCHEMA_VERSION,
  type ObjectSource,
  type ReadSnapshotOptions,
  type RepositorySnapshot,
} from "./snapshot.ts";

export interface CachedRemote {
  /** Namespace key inside the cache (see cacheNamespace). */
  key: string;
  /** Name shown to people, e.g. `origin`. */
  name: string;
}

function remoteNamespaces(
  remote: CachedRemote,
  includeTags: boolean,
): RefNamespace[] {
  const ns = cacheNamespace(remote.key);
  return [
    { prefix: `${ns}/heads/`, kind: "remote-branch", remote: remote.name },
    ...(includeTags ? [{ prefix: `${ns}/tags/`, kind: "tag" as const }] : []),
  ];
}

/** A repository known only by URL, read entirely from its cache. */
export async function readRemoteOnlySnapshot(
  cacheDir: string,
  remote: CachedRemote,
  options: { now?: () => number } = {},
): Promise<RepositorySnapshot> {
  const now = options.now ?? Date.now;
  const location = await resolveRepository(cacheDir);
  const refs = await readRefs(cacheDir, {
    namespaces: remoteNamespaces(remote, true),
  });
  const objects: ObjectSource = { cwd: cacheDir, alternates: [] };
  const tips = commitTips(refs, []);
  const topology = await readTopologyTolerant(objects, tips, undefined);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: now(),
    location,
    refs,
    worktrees: [],
    topology,
    objects,
    completeness: {
      // Callers serialize cache reads with fetches (see withCache in the monitor).
      coherent: true,
      attempts: 1,
      shallow: false,
      grafts: false,
      missingTips: missingTips(refs, tips, topology),
    },
  };
}

/**
 * A local repository whose listed remotes are monitored through the cache.
 * Remotes not yet fetched keep the clone's tracking refs (labelled as last
 * fetched by the clone), so nothing disappears before the first fetch.
 */
export async function readLocalWithRemotes(
  path: string,
  cacheDir: string,
  remotes: readonly CachedRemote[],
  options: ReadSnapshotOptions & { fetched?: ReadonlySet<string> } = {},
): Promise<RepositorySnapshot> {
  const local = await readSnapshot(path, options);
  const live = remotes.filter((r) => options.fetched?.has(r.key) ?? true);
  if (live.length === 0) return local;

  const liveNames = new Set(live.map((r) => r.name));
  const cacheRefs: GitRef[] = await readRefs(cacheDir, {
    namespaces: live.flatMap((r) => remoteNamespaces(r, false)),
  });
  const refs = [
    ...local.refs.filter(
      (r) => !(r.kind === "remote-branch" && liveNames.has(r.remote ?? "")),
    ),
    ...cacheRefs,
  ];
  const objects: ObjectSource = {
    cwd: cacheDir,
    alternates: [join(local.location.commonDir, "objects")],
  };
  const tips = commitTips(refs, local.worktrees);
  const topology = await readTopologyTolerant(
    objects,
    tips,
    join(local.location.commonDir, "shallow"),
  );
  return {
    ...local,
    refs,
    topology,
    objects,
    completeness: {
      ...local.completeness,
      missingTips: missingTips(refs, tips, topology),
    },
  };
}
