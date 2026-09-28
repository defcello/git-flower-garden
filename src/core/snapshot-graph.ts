/**
 * Turn a repository snapshot into graph-selection input and display labels.
 * Branch heads (local and remote-tracking) drive selection; tags decorate the
 * commits that are already visible; worktree HEADs are always visible.
 */
import type { RepositorySnapshot } from "../git/snapshot.ts";
import type { HistoryWindow } from "./business-days.ts";
import type { GraphInput } from "./visible-graph.ts";

export function snapshotGraphInput(
  snapshot: RepositorySnapshot,
  window: HistoryWindow,
  reveal: readonly string[] = [],
  maxRecent: number | null = null,
): GraphInput {
  const heads = snapshot.refs
    .filter(
      (r) => (r.kind === "branch" || r.kind === "remote-branch") && r.commitOid,
    )
    .map((r) => ({ id: r.name, commitOid: r.commitOid as string }));
  return {
    commits: snapshot.topology.commits,
    shallowBoundary: snapshot.topology.shallowBoundary,
    heads,
    worktreeHeads: snapshot.worktrees.flatMap((w) =>
      w.headOid ? [w.headOid] : [],
    ),
    window,
    reveal,
    maxRecent,
  };
}

/** Human labels per commit: `main`, `origin/main`, `tag: v1.0`, in a stable order. */
export function refLabels(snapshot: RepositorySnapshot): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  const kindOrder = { branch: 0, "remote-branch": 1, tag: 2 } as const;
  const sorted = [...snapshot.refs].sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] || (a.name < b.name ? -1 : 1),
  );
  for (const ref of sorted) {
    if (!ref.commitOid) continue;
    const text =
      ref.kind === "branch"
        ? ref.shortName
        : ref.kind === "remote-branch"
          ? `${ref.remote ?? "?"}/${ref.shortName}`
          : `tag: ${ref.shortName}`;
    labels.set(ref.commitOid, [...(labels.get(ref.commitOid) ?? []), text]);
  }
  return labels;
}

/** Layout priority: commits under the checked-out branch first, then other local branches. */
export function lanePriority(
  snapshot: RepositorySnapshot,
): Map<string, number> {
  const priority = new Map<string, number>();
  const main = snapshot.worktrees.find((w) => w.main);
  if (main?.headOid) priority.set(main.headOid, 0);
  let next = 1;
  for (const ref of [...snapshot.refs].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (
      ref.kind === "branch" &&
      ref.commitOid &&
      !priority.has(ref.commitOid)
    ) {
      priority.set(ref.commitOid, next++);
    }
  }
  return priority;
}
