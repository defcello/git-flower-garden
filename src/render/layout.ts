/**
 * Deterministic upward layout for a visible graph (roadmap section 7).
 *
 * - Rows: one commit per row in topological order, so parents are always
 *   strictly below children whatever the commit timestamps say.
 * - Lanes: newest rows first, each commit hands its lane down to its first
 *   visible parent (as gitk does). A commit without a reserved lane takes the
 *   lowest lane free for the whole span down to its first parent, so a lane
 *   never has two commits' paths overlapping.
 * - Ties break on a caller-supplied priority (e.g. the default branch first)
 *   and then OID, never on input order, so identical graphs lay out identically.
 */
import type { VisibleGraph } from "../core/visible-graph.ts";

export interface LayoutOptions {
  laneWidth?: number;
  rowHeight?: number;
  margin?: number;
  /** Lower sorts first (leftmost). Commits not listed get Infinity. */
  priority?: ReadonlyMap<string, number>;
}

export interface LayoutNode {
  oid: string;
  lane: number;
  row: number;
  x: number;
  y: number;
}

export interface LayoutEdge {
  child: string;
  parent: string;
  kind: "direct" | "collapsed";
  hidden: number | null;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /**
   * Horizontal offset of a detour, set when both ends share a lane but other
   * commits sit between them (possible for non-first-parent edges). A
   * straight line would pass through those commits.
   */
  detour?: number;
}

export interface LayoutTail {
  child: string;
  hidden: number | null;
  boundary: boolean;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface Layout {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  tails: LayoutTail[];
  lanes: number;
  rows: number;
  width: number;
  height: number;
}

export function layoutGraph(
  graph: VisibleGraph,
  options: LayoutOptions = {},
): Layout {
  const laneWidth = options.laneWidth ?? 28;
  const rowHeight = options.rowHeight ?? 36;
  const margin = options.margin ?? 24;
  const priority = options.priority ?? new Map<string, number>();

  // Visible parents in Git parent order; collapsed edges have no index, so they follow.
  const parents = new Map<string, string[]>();
  for (const oid of graph.nodes.keys()) parents.set(oid, []);
  // Ties (collapsed edges, which have no parent index) break on OID so the
  // choice of lane-inheriting parent never depends on input order.
  const ordered = [...graph.edges].sort(
    (a, b) =>
      (a.parentIndexes[0] ?? Number.MAX_SAFE_INTEGER) -
        (b.parentIndexes[0] ?? Number.MAX_SAFE_INTEGER) ||
      compare(a.parent, b.parent) ||
      compare(a.kind, b.kind),
  );
  for (const edge of ordered) {
    const list = parents.get(edge.child) as string[];
    if (!list.includes(edge.parent)) list.push(edge.parent);
  }

  // One commit per row, in a topological order: a commit is placed only after
  // every visible child, so parents are always strictly lower. Among commits
  // that are ready together, newer committer time goes higher (like gitk's
  // date order), then lane priority, then OID. Timestamps only break ties, so
  // clock skew can reorder siblings but never invert an edge.
  const tailed = new Set(graph.tails.map((t) => t.child));
  const pendingChildren = new Map<string, number>();
  for (const oid of graph.nodes.keys()) pendingChildren.set(oid, 0);
  for (const [, ps] of parents) {
    for (const p of ps)
      pendingChildren.set(p, (pendingChildren.get(p) as number) + 1);
  }
  const rank = (oid: string): number =>
    priority.get(oid) ?? Number.POSITIVE_INFINITY;
  const before = (a: string, b: string): boolean => {
    const ta = graph.nodes.get(a)?.committerTime ?? 0;
    const tb = graph.nodes.get(b)?.committerTime ?? 0;
    if (ta !== tb) return ta > tb;
    const dp = rank(a) - rank(b);
    if (dp !== 0) return dp < 0;
    return a < b;
  };
  const ready = new MinHeap<string>(before);
  for (const [oid, count] of pendingChildren) if (count === 0) ready.push(oid);
  const order: string[] = [];
  while (ready.size > 0) {
    const oid = ready.pop() as string;
    order.push(oid);
    for (const p of parents.get(oid) ?? []) {
      const left = (pendingChildren.get(p) as number) - 1;
      pendingChildren.set(p, left);
      if (left === 0) ready.push(p);
    }
  }
  if (order.length !== graph.nodes.size)
    throw new Error("Visible graph contains a cycle");
  // Row 0 is left free for history tails when there are any.
  const base = tailed.size > 0 ? 1 : 0;
  const row = new Map<string, number>();
  order.forEach((oid, i) => row.set(oid, base + order.length - 1 - i));

  // Occupied row spans per lane, [low, high] inclusive.
  const spans: [number, number][][] = [];
  const free = (lane: number, low: number, high: number): boolean =>
    (spans[lane] ?? []).every(([l, h]) => h < low || l > high);
  const reserved = new Map<string, number[]>(); // parent oid -> lanes handed down by children
  const lane = new Map<string, number>();

  for (const oid of order) {
    const r = row.get(oid) as number;
    const firstParent = parents.get(oid)?.[0];
    const bottom =
      firstParent === undefined
        ? tailed.has(oid)
          ? r - 1
          : r
        : (row.get(firstParent) as number);
    let chosen = Math.min(...(reserved.get(oid) ?? [Number.POSITIVE_INFINITY]));
    if (!Number.isFinite(chosen)) {
      chosen = 0;
      while (!free(chosen, bottom, r)) chosen++;
    } else if (!free(chosen, bottom, r - 1) && bottom < r) {
      // The inherited lane is blocked further down; move this commit to a clear lane.
      chosen = 0;
      while (!free(chosen, bottom, r)) chosen++;
    }
    lane.set(oid, chosen);
    (spans[chosen] ??= []).push([bottom, r]);
    if (firstParent !== undefined)
      reserved.set(firstParent, [...(reserved.get(firstParent) ?? []), chosen]);
  }

  const rows = order.length + base;
  const lanes = Math.max(0, ...lane.values()) + 1;
  const height = margin * 2 + (rows - 1) * rowHeight;
  const point = (l: number, r: number) => ({
    x: margin + l * laneWidth,
    y: height - margin - r * rowHeight,
  });

  const nodes = new Map<string, LayoutNode>();
  for (const oid of [...graph.nodes.keys()].sort(compare)) {
    const l = lane.get(oid) as number;
    const r = row.get(oid) as number;
    nodes.set(oid, { oid, lane: l, row: r, ...point(l, r) });
  }
  const rowsInLane = new Map<number, number[]>();
  for (const n of nodes.values()) {
    rowsInLane.set(n.lane, [...(rowsInLane.get(n.lane) ?? []), n.row]);
  }
  const at = (oid: string) => {
    const n = nodes.get(oid) as LayoutNode;
    return { x: n.x, y: n.y };
  };
  return {
    nodes,
    edges: [...graph.edges].sort(edgeOrder).map((e) => {
      const child = nodes.get(e.child) as LayoutNode;
      const parent = nodes.get(e.parent) as LayoutNode;
      const blocked =
        child.lane === parent.lane &&
        (rowsInLane.get(child.lane) ?? []).some(
          (r) => r > parent.row && r < child.row,
        );
      return {
        child: e.child,
        parent: e.parent,
        kind: e.kind,
        hidden: e.hidden,
        from: at(e.child),
        to: at(e.parent),
        ...(blocked ? { detour: laneWidth / 2 } : {}),
      };
    }),
    tails: [...graph.tails]
      .sort(
        (a, b) =>
          compare(a.child, b.child) || Number(a.boundary) - Number(b.boundary),
      )
      .map((t) => {
        const from = at(t.child);
        // Straight down when the lane below is the tail's alone; angled off the
        // first-parent edge when the commit also has visible parents.
        const dx = (parents.get(t.child)?.length ?? 0) > 0 ? laneWidth / 2 : 0;
        return {
          ...t,
          from,
          to: { x: from.x + dx, y: from.y + rowHeight * 0.8 },
        };
      }),
    lanes,
    rows,
    width: margin * 2 + (lanes - 1) * laneWidth,
    height,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function edgeOrder(
  a: { child: string; parent: string; kind: string },
  b: { child: string; parent: string; kind: string },
): number {
  return (
    compare(a.child, b.child) ||
    compare(a.parent, b.parent) ||
    compare(a.kind, b.kind)
  );
}

/** Binary heap ordered by `before(a, b)` meaning "a comes out first". */
class MinHeap<T> {
  private readonly items: T[] = [];
  private readonly before: (a: T, b: T) => boolean;

  constructor(before: (a: T, b: T) => boolean) {
    this.before = before;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i] as T, items[parent] as T)) break;
      [items[i], items[parent]] = [items[parent] as T, items[i] as T];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && this.before(items[l] as T, items[best] as T))
          best = l;
        if (r < items.length && this.before(items[r] as T, items[best] as T))
          best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best] as T, items[i] as T];
        i = best;
      }
    }
    return top;
  }
}
