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

export interface RepositorySnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** Milliseconds since the epoch when the read completed. */
  capturedAt: number;
  location: RepositoryLocation;
  refs: GitRef[];
  worktrees: GitWorktree[];
  topology: Topology;
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

export async function readSnapshot(
  path: string,
  options: { now?: () => number } = {},
): Promise<RepositorySnapshot> {
  const now = options.now ?? Date.now;
  const location = await resolveRepository(path);
  const cwd = location.workTree ?? location.gitDir;

  let refs = await readRefs(cwd);
  let worktrees = await readWorktrees(cwd);
  for (let attempt = 1; ; attempt++) {
    const tips = commitTips(refs, worktrees);
    const topology = await readTopology(cwd, tips, {
      shallowFile: join(location.commonDir, "shallow"),
    }).catch((error: unknown) => {
      // rev-list fails outright if any tip is missing; fall back to reading tips one at a time.
      return readAvailable(cwd, tips, location, error);
    });
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
        completeness: {
          coherent,
          attempts: attempt,
          shallow: location.shallow,
          grafts: location.grafts,
          missingTips: [
            ...new Set([
              ...refs
                .filter((r) => r.objectType === "missing")
                .map((r) => r.oid),
              ...tips.filter((tip) => !topology.commits.has(tip)),
            ]),
          ].sort(),
        },
      };
    }
    refs = refsAfter;
    worktrees = worktreesAfter;
  }
}

async function readAvailable(
  cwd: string,
  tips: readonly string[],
  location: RepositoryLocation,
  original: unknown,
): Promise<Topology> {
  const merged: Topology = { commits: new Map(), shallowBoundary: new Set() };
  let anyRead = false;
  for (const tip of tips) {
    try {
      const part = await readTopology(cwd, [tip], {
        shallowFile: join(location.commonDir, "shallow"),
      });
      for (const [oid, entry] of part.commits) merged.commits.set(oid, entry);
      for (const oid of part.shallowBoundary) merged.shallowBoundary.add(oid);
      anyRead = true;
    } catch {
      // This tip's history is unavailable; it is reported in missingTips.
    }
  }
  if (!anyRead && tips.length > 0) throw original;
  return merged;
}
