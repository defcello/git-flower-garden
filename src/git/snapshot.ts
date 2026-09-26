/**
 * A coherent, immutable read of one local repository (roadmap section 5.1).
 *
 * Ref and worktree targets are read first, then the commits they reach, then
 * the targets again. If any target moved meanwhile the read is retried; after
 * repeated churn the result is marked incoherent so callers keep their last
 * coherent snapshot and show "updating" instead of publishing a half-read graph.
 */
import { join } from "node:path";
import { readTopology, type Topology } from "./commits.ts";
import { readRefs, type GitRef } from "./refs.ts";
import { resolveRepository, type RepositoryLocation } from "./repository.ts";
import { readWorktrees, type GitWorktree } from "./worktrees.ts";

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Where commit objects for this snapshot are read (see remote-snapshot.ts). */
export interface ObjectSource {
  cwd: string;
  /** Extra object directories for this read only (GIT_ALTERNATE_OBJECT_DIRECTORIES). */
  alternates: string[];
}

export interface RepositorySnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** Milliseconds since the epoch when the read completed. */
  capturedAt: number;
  location: RepositoryLocation;
  refs: GitRef[];
  worktrees: GitWorktree[];
  topology: Topology;
  /** Object source for commit details. */
  objects: ObjectSource;
  /**
   * Stat fingerprint of the ref metadata taken before the read, when the read
   * was verified coherent by an unchanged fingerprint (see readSnapshot).
   */
  fingerprint?: string;
  completeness: {
    /** Refs and worktrees did not move during the read. */
    coherent: boolean;
    attempts: number;
    shallow: boolean;
    grafts: boolean;
    /** Ref or worktree targets whose commits could not be read. */
    missingTips: string[];
  };
}

const MAX_ATTEMPTS = 3;

function targetsKey(
  refs: readonly GitRef[],
  worktrees: readonly GitWorktree[],
): string {
  return [
    ...refs.map((r) => `${r.name}=${r.oid}`),
    ...worktrees.map(
      (w) => `wt:${w.path}=${w.headOid ?? "unborn"}:${w.branch ?? ""}`,
    ),
  ]
    .sort()
    .join("\n");
}

export function commitTips(
  refs: readonly GitRef[],
  worktrees: readonly GitWorktree[],
): string[] {
  const tips = new Set<string>();
  for (const ref of refs) if (ref.commitOid) tips.add(ref.commitOid);
  for (const worktree of worktrees)
    if (worktree.headOid) tips.add(worktree.headOid);
  return [...tips].sort();
}

export function missingTips(
  refs: readonly GitRef[],
  tips: readonly string[],
  topology: Topology,
): string[] {
  return [
    ...new Set([
      ...refs.filter((r) => r.objectType === "missing").map((r) => r.oid),
      ...tips.filter((tip) => !topology.commits.has(tip)),
    ]),
  ].sort();
}

/**
 * Read the topology reachable from `tips`. `rev-list` fails outright if any
 * tip is missing, so on failure each tip is read alone and unavailable ones
 * are left out (callers report them as missing).
 */
export async function readTopologyTolerant(
  objects: ObjectSource,
  tips: readonly string[],
  shallowFile: string | undefined,
): Promise<Topology> {
  const options = {
    alternates: objects.alternates,
    ...(shallowFile === undefined ? {} : { shallowFile }),
  };
  try {
    return await readTopology(objects.cwd, tips, options);
  } catch (error) {
    const merged: Topology = { commits: new Map(), shallowBoundary: new Set() };
    let anyRead = false;
    for (const tip of tips) {
      try {
        const part = await readTopology(objects.cwd, [tip], options);
        for (const [oid, entry] of part.commits) merged.commits.set(oid, entry);
        for (const oid of part.shallowBoundary) merged.shallowBoundary.add(oid);
        anyRead = true;
      } catch {
        // This tip's history is unavailable; it is reported in missingTips.
      }
    }
    if (!anyRead && tips.length > 0) throw error;
    return merged;
  }
}

export interface ReadSnapshotOptions {
  now?: () => number;
  /**
   * Cheap stat fingerprint of the ref metadata. When the fingerprint is the
   * same before and after reading, nothing moved during the read and the
   * refs need not be read a second time to prove coherence.
   */
  fingerprint?: (commonDir: string) => Promise<string>;
}

export async function readSnapshot(
  path: string,
  options: ReadSnapshotOptions = {},
): Promise<RepositorySnapshot> {
  const now = options.now ?? Date.now;
  const location = await resolveRepository(path);
  const cwd = location.workTree ?? location.gitDir;
  const objects: ObjectSource = { cwd, alternates: [] };

  const before = await options.fingerprint?.(location.commonDir);
  let refs = await readRefs(cwd);
  let worktrees = await readWorktrees(cwd);
  if (before !== undefined && options.fingerprint) {
    const tips = commitTips(refs, worktrees);
    const topology = await readTopologyTolerant(
      objects,
      tips,
      join(location.commonDir, "shallow"),
    );
    if ((await options.fingerprint(location.commonDir)) === before) {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        capturedAt: now(),
        location,
        refs,
        worktrees,
        topology,
        objects,
        fingerprint: before,
        completeness: {
          coherent: true,
          attempts: 1,
          shallow: location.shallow,
          grafts: location.grafts,
          missingTips: missingTips(refs, tips, topology),
        },
      };
    }
    // Something moved: fall back to verifying by re-reading.
    refs = await readRefs(cwd);
    worktrees = await readWorktrees(cwd);
  }
  for (let attempt = 1; ; attempt++) {
    const tips = commitTips(refs, worktrees);
    const topology = await readTopologyTolerant(
      objects,
      tips,
      join(location.commonDir, "shallow"),
    );
    const refsAfter = await readRefs(cwd);
    const worktreesAfter = await readWorktrees(cwd);
    const coherent =
      targetsKey(refs, worktrees) === targetsKey(refsAfter, worktreesAfter);
    if (coherent || attempt >= MAX_ATTEMPTS) {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        capturedAt: now(),
        location,
        refs,
        worktrees,
        topology,
        objects,
        completeness: {
          coherent,
          attempts: attempt,
          shallow: location.shallow,
          grafts: location.grafts,
          missingTips: missingTips(refs, tips, topology),
        },
      };
    }
    refs = refsAfter;
    worktrees = worktreesAfter;
  }
}
