/**
 * Mandatory commit selection and honest edge reduction (roadmap section 4.4).
 *
 * Visible commits M = branch heads ∪ required ancestor anchors ∪ commits in
 * the recent window ∪ worktree HEADs (∪ commits explicitly revealed for
 * inspection). Every other reachable commit is hidden. Edges connect each
 * visible commit to the first visible commits reached along each parent path:
 *
 * - "direct": the visible parent is an actual Git parent.
 * - "collapsed": the path passes through hidden commits. `hidden` is the exact
 *   number of hidden commits when exactly one such path exists, else null
 *   ("multiple paths").
 *
 * Hidden ancestry that reaches no visible commit becomes a "tail" (history
 * continues to a root) or a boundary tail (history is missing: shallow clone
 * or unavailable object). No edge implies ancestry that does not exist.
 */
import { selectAncestorAnchors } from "./ancestor-anchors.ts";
import { inWindow, type HistoryWindow } from "./business-days.ts";

export interface TopologyCommit {
  parents: readonly string[];
  committerTime: number;
}

export interface HeadRef {
  /** Stable, source-qualified ref identifier. */
  id: string;
  commitOid: string;
}

export interface GraphInput {
  commits: ReadonlyMap<string, TopologyCommit>;
  /** Commits whose parents were cut off by a shallow clone. */
  shallowBoundary?: ReadonlySet<string>;
  /** Branch heads (local and remote-tracking) in scope. Tags are decorations, not heads. */
  heads: readonly HeadRef[];
  /** HEAD commits of worktrees (unborn worktrees contribute nothing). */
  worktreeHeads?: readonly string[];
  window: HistoryWindow;
  /** Commits temporarily revealed, e.g. an old tag being inspected. */
  reveal?: readonly string[];
}

export type InclusionReason =
  "head" | "ancestor" | "recent" | "worktree" | "inspection";

export interface VisibleNode {
  oid: string;
  reasons: InclusionReason[];
  /** For ancestor anchors: the distinct head commits it is a best common ancestor for. */
  anchorFor?: readonly string[];
  /** Committer time, seconds since the epoch (for display and tie-breaking only). */
  committerTime: number;
  /** Committer time is after the window's `now`. */
  futureDated: boolean;
  /** This commit's own parents are unknown (shallow boundary). */
  boundary: boolean;
}

export interface VisibleEdge {
  child: string;
  parent: string;
  kind: "direct" | "collapsed";
  /** For direct edges: positions of this parent in the child's parent list. */
  parentIndexes: number[];
  /** For collapsed edges: exact hidden commit count if the path is unique, else null. */
  hidden: number | null;
}

export interface HiddenTail {
  child: string;
  /** Hidden commits before history ends, if exactly one path; else null. */
  hidden: number | null;
  /** True when history ends because objects are missing, not at a real root. */
  boundary: boolean;
}

export interface VisibleGraph {
  nodes: Map<string, VisibleNode>;
  edges: VisibleEdge[];
  tails: HiddenTail[];
  window: HistoryWindow;
  reachableCount: number;
}

interface PathSummary {
  /** Number of distinct paths, capped at 2 ("more than one"). */
  paths: number;
  /** Hidden commits along the path, meaningful only when paths === 1. */
  length: number;
}

interface HiddenInfo {
  ends: Map<string, PathSummary>;
  root: PathSummary | null;
  missing: PathSummary | null;
}

function addPath(
  into: Map<string, PathSummary>,
  key: string,
  add: PathSummary,
): void {
  const existing = into.get(key);
  if (!existing) into.set(key, { ...add });
  else existing.paths = Math.min(2, existing.paths + add.paths);
}

function merge(a: PathSummary | null, b: PathSummary): PathSummary {
  return a
    ? { paths: Math.min(2, a.paths + b.paths), length: a.length }
    : { ...b };
}

export function buildVisibleGraph(input: GraphInput): VisibleGraph {
  const { commits, window } = input;
  const shallow = input.shallowBoundary ?? new Set<string>();
  const nodes = new Map<string, VisibleNode>();
  const mark = (
    oid: string,
    reason: InclusionReason,
  ): VisibleNode | undefined => {
    const commit = commits.get(oid);
    if (!commit) return undefined;
    let node = nodes.get(oid);
    if (!node) {
      node = {
        oid,
        reasons: [],
        committerTime: commit.committerTime,
        futureDated: commit.committerTime * 1000 > window.endMs,
        boundary: shallow.has(oid),
      };
      nodes.set(oid, node);
    }
    if (!node.reasons.includes(reason)) node.reasons.push(reason);
    return node;
  };

  const parentMap = new Map<string, readonly string[]>();
  for (const [oid, commit] of commits) parentMap.set(oid, commit.parents);

  // Reachable set from all tips; only these commits can be shown.
  const tips = [
    ...input.heads.map((h) => h.commitOid),
    ...(input.worktreeHeads ?? []),
    ...(input.reveal ?? []),
  ].filter((oid) => commits.has(oid));
  const reachable = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    for (const parent of commits.get(oid)?.parents ?? []) {
      if (commits.has(parent) && !reachable.has(parent)) stack.push(parent);
    }
  }

  for (const head of input.heads) mark(head.commitOid, "head");
  const headOids = input.heads
    .map((h) => h.commitOid)
    .filter((oid) => commits.has(oid));
  for (const anchor of selectAncestorAnchors(parentMap, headOids)) {
    const node = mark(anchor.oid, "ancestor");
    if (node) node.anchorFor = anchor.heads;
  }
  for (const oid of reachable) {
    if (inWindow(window, (commits.get(oid) as TopologyCommit).committerTime))
      mark(oid, "recent");
  }
  for (const oid of input.worktreeHeads ?? []) mark(oid, "worktree");
  for (const oid of input.reveal ?? []) mark(oid, "inspection");

  // Summaries of hidden regions, memoized so shared old history is walked once.
  const info = new Map<string, HiddenInfo>();
  const hiddenInfo = (start: string): HiddenInfo => {
    const work: [string, boolean][] = [[start, false]];
    while (work.length > 0) {
      const [oid, expanded] = work.pop() as [string, boolean];
      if (info.has(oid)) continue;
      const parents = commits.get(oid)?.parents ?? [];
      if (!expanded) {
        work.push([oid, true]);
        for (const p of parents) {
          if (commits.has(p) && !nodes.has(p) && !info.has(p))
            work.push([p, false]);
        }
        continue;
      }
      const result: HiddenInfo = { ends: new Map(), root: null, missing: null };
      if (parents.length === 0) {
        const self = { paths: 1, length: 1 };
        if (shallow.has(oid)) result.missing = self;
        else result.root = self;
      }
      for (const p of parents) {
        if (!commits.has(p)) {
          result.missing = merge(result.missing, { paths: 1, length: 1 });
        } else if (nodes.has(p)) {
          addPath(result.ends, p, { paths: 1, length: 1 });
        } else {
          const sub = info.get(p) as HiddenInfo;
          for (const [end, s] of sub.ends)
            addPath(result.ends, end, { paths: s.paths, length: s.length + 1 });
          if (sub.root)
            result.root = merge(result.root, {
              paths: sub.root.paths,
              length: sub.root.length + 1,
            });
          if (sub.missing) {
            result.missing = merge(result.missing, {
              paths: sub.missing.paths,
              length: sub.missing.length + 1,
            });
          }
        }
      }
      info.set(oid, result);
    }
    return info.get(start) as HiddenInfo;
  };

  const edges: VisibleEdge[] = [];
  const tails: HiddenTail[] = [];
  const sortedNodes = [...nodes.keys()].sort();
  for (const child of sortedNodes) {
    const parents = commits.get(child)?.parents ?? [];
    const direct = new Map<string, number[]>();
    const collapsed = new Map<string, PathSummary>();
    let root: PathSummary | null = null;
    let missing: PathSummary | null = null;
    parents.forEach((p, index) => {
      if (!commits.has(p)) {
        missing = merge(missing, { paths: 1, length: 0 });
      } else if (nodes.has(p)) {
        direct.set(p, [...(direct.get(p) ?? []), index]);
      } else {
        const sub = hiddenInfo(p);
        for (const [end, s] of sub.ends) addPath(collapsed, end, s);
        if (sub.root) root = merge(root, sub.root);
        if (sub.missing) missing = merge(missing, sub.missing);
      }
    });
    for (const [parent, parentIndexes] of direct) {
      edges.push({
        child,
        parent,
        kind: "direct",
        parentIndexes,
        hidden: null,
      });
    }
    for (const [parent, s] of collapsed) {
      edges.push({
        child,
        parent,
        kind: "collapsed",
        parentIndexes: [],
        hidden: s.paths === 1 ? s.length : null,
      });
    }
    const r = root as PathSummary | null;
    const m = missing as PathSummary | null;
    if (r)
      tails.push({
        child,
        hidden: r.paths === 1 ? r.length : null,
        boundary: false,
      });
    if (m)
      tails.push({
        child,
        hidden: m.paths === 1 ? m.length : null,
        boundary: true,
      });
  }

  edges.sort((a, b) =>
    a.child === b.child
      ? a.parent === b.parent
        ? a.kind.localeCompare(b.kind)
        : a.parent < b.parent
          ? -1
          : 1
      : a.child < b.child
        ? -1
        : 1,
  );
  return { nodes, edges, tails, window, reachableCount: reachable.size };
}
