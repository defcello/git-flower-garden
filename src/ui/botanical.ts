import type { GraphJson } from "../api/types.ts";
import { edgeCurve, edgePath } from "./edge-path.ts";
import { SPRITE_ATLAS } from "./scene/atlas.ts";

export type Renderer = "technical" | "canvas" | "svg";

type Point = { x: number; y: number };

export interface Stem {
  /** Stable identity: child and parent (or "tail") OIDs. */
  key: string;
  /** Filled, tapered outline; for a dashed stem, its centerline. */
  path: string;
  /** Slightly wider outline under the stem: a pale separation at crossings. */
  halo: string;
  /** Vertical extent, for skipping off-screen stems. */
  top: number;
  bottom: number;
  /** Mean width: dashed stroke width and draw order. */
  width: number;
  color: string;
  /** Hidden history (collapsed edge or tail): a segmented centerline. */
  dashed: boolean;
}
/** A small knot where a commit sits on its stem. */
export interface Knot {
  key: string;
  x: number;
  y: number;
  r: number;
}
export interface Sprite {
  /** Stable identity: flowers by ref, leaves by commit, fruit by tag. */
  key: string;
  kind: number;
  x: number;
  y: number;
  size: number;
  /** Seeded variation: rotation in radians and mirroring. */
  rotate: number;
  flip: boolean;
}
/** A soft shadow where the plant meets the ground. */
export interface Ground {
  key: string;
  x: number;
  y: number;
  width: number;
}
export interface Scene {
  stems: Stem[];
  knots: Knot[];
  sprites: Sprite[];
  grounds: Ground[];
}

// The relit sprite atlas (scene/protocol.ts): 2×2 cells, in `kind` order
// (coral flower, lavender flower, leaf pair, berry).
export const ATLAS_SIZE = SPRITE_ATLAS;
export const CELL_SIZE = ATLAS_SIZE / 2;

export const STEM_COLOR = "#456b39";
export const KNOT_COLOR = "#34532b";
export const HALO_COLOR = "#e0e9cf";
export const BOUNDARY_COLOR = "#9a3b2a";

/** Taper bounds (roadmap P2-B): no stem thinner or thicker than these. */
export const MIN_WIDTH = 1.8;
export const MAX_WIDTH = 7;

function hash(identity: string): number {
  let h = 2166136261;
  for (const char of identity) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A stable number in [0, 1) for an identity. */
export function seeded(identity: string): number {
  return hash(identity) / 2 ** 32;
}

/** Ref-based seed: moving a head must not change its flower family. */
export function flowerVariant(identity: string): number {
  return hash(identity) % 2;
}

/** Visible stems leaving each commit downward: parent edges plus history tails. */
function stemCounts(graph: GraphJson): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of graph.edges)
    counts.set(e.child, (counts.get(e.child) ?? 0) + 1);
  for (const t of graph.tails)
    counts.set(t.child, (counts.get(t.child) ?? 0) + 1);
  return counts;
}

/**
 * Branch flow through each visible commit. Every tip (a commit with no
 * visible child) contributes 1, and a commit passes its flow down split
 * evenly over its stems (visible parents and hidden-history tails). Flow is
 * conserved: a fork's lower stem carries the sum of its branches, and a
 * merge's incoming stems each carry a share of the merged stem.
 */
export function branchFlow(graph: GraphJson): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = children.get(e.parent) ?? [];
    list.push(e.child);
    children.set(e.parent, list);
  }
  const stems = stemCounts(graph);
  const flow = new Map<string, number>();
  // Children are always drawn above (at smaller y than) their parents.
  const order = [...graph.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const node of order) {
    const kids = children.get(node.oid) ?? [];
    let total = kids.length === 0 ? 1 : 0;
    for (const kid of kids)
      total += (flow.get(kid) ?? 1) / Math.max(1, stems.get(kid) ?? 1);
    flow.set(node.oid, total);
  }
  return flow;
}

/**
 * Stem width for a share of branch flow at a height: grows with the square
 * root of flow and gently toward the ground, clamped so a large merge never
 * becomes an unreadable trunk.
 */
export function stemWidth(flow: number, y: number, height: number): number {
  const low = height > 0 ? Math.min(1, Math.max(0, y / height)) : 0;
  const w = 1.2 + 1.4 * Math.sqrt(Math.max(0, flow)) + 0.8 * low;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
}

function cubic(p: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = p;
  const k0 = u * u * u,
    k1 = 3 * u * u * t,
    k2 = 3 * u * t * t,
    k3 = t * t * t;
  return {
    x: k0 * a.x + k1 * b.x + k2 * c.x + k3 * d.x,
    y: k0 * a.y + k1 * b.y + k2 * c.y + k3 * d.y,
  };
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/**
 * A closed outline along a cubic, `topWidth` wide at its start and
 * `bottomWidth` at its end. Its centerline, and so both endpoints, is the
 * edge's own curve.
 */
export function taperedOutline(
  curve: [Point, Point, Point, Point],
  topWidth: number,
  bottomWidth: number,
  samples = 12,
): string {
  const points = Array.from({ length: samples + 1 }, (_, i) =>
    cubic(curve, i / samples),
  );
  const left: Point[] = [];
  const right: Point[] = [];
  for (const [i, p] of points.entries()) {
    const prev = points[Math.max(0, i - 1)] ?? p;
    const next = points[Math.min(samples, i + 1)] ?? p;
    const length = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const dx = (next.x - prev.x) / length;
    const dy = (next.y - prev.y) / length;
    const half = (topWidth + (bottomWidth - topWidth) * (i / samples)) / 2;
    left.push({ x: p.x - dy * half, y: p.y + dx * half });
    right.push({ x: p.x + dy * half, y: p.y - dx * half });
  }
  return (
    [...left, ...right.reverse()]
      .map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`)
      .join(" ") + " Z"
  );
}

/** Both compositors consume this exact geometry; decoration cannot add ancestry. */
export function botanicalScene(graph: GraphJson): Scene {
  const flow = branchFlow(graph);
  const counts = stemCounts(graph);
  const share = (child: string) =>
    (flow.get(child) ?? 1) / Math.max(1, counts.get(child) ?? 1);
  const height = graph.size.height;
  const widest = new Map<string, number>();
  const touch = (oid: string, w: number) => {
    widest.set(oid, Math.max(widest.get(oid) ?? 0, w));
  };

  const stems: Stem[] = graph.edges.map((edge) => {
    const f = share(edge.child);
    const top = stemWidth(f, edge.from.y, height);
    const bottom = stemWidth(f, edge.to.y, height);
    touch(edge.child, top);
    touch(edge.parent, bottom);
    const dashed = edge.kind === "collapsed";
    const curve = edgeCurve(edge);
    return {
      key: `${edge.child}>${edge.parent}`,
      path: dashed ? edgePath(edge) : taperedOutline(curve, top, bottom),
      halo: dashed
        ? edgePath(edge)
        : taperedOutline(curve, top + 2.5, bottom + 2.5),
      top: Math.min(edge.from.y, edge.to.y),
      bottom: Math.max(edge.from.y, edge.to.y),
      width: (top + bottom) / 2,
      color: STEM_COLOR,
      dashed,
    };
  });
  for (const tail of graph.tails) {
    const w = stemWidth(
      share(tail.child),
      (tail.from.y + tail.to.y) / 2,
      height,
    );
    touch(tail.child, w);
    const line = `M${fmt(tail.from.x)} ${fmt(tail.from.y)} L${fmt(tail.to.x)} ${fmt(tail.to.y)}`;
    stems.push({
      key: `${tail.child}>tail`,
      path: line,
      halo: line,
      top: Math.min(tail.from.y, tail.to.y),
      bottom: Math.max(tail.from.y, tail.to.y),
      width: w,
      color: tail.boundary ? BOUNDARY_COLOR : STEM_COLOR,
      dashed: true,
    });
  }
  // Depth: thinner stems pass behind thicker ones, each over its own pale
  // halo, so a crossing never reads as a junction. The order is stable.
  stems.sort((a, b) => a.width - b.width || (a.key < b.key ? -1 : 1));

  const knots: Knot[] = graph.nodes.map((node) => ({
    key: node.oid,
    x: node.x,
    y: node.y,
    r: Math.min(4, Math.max(1.6, (widest.get(node.oid) ?? MIN_WIDTH) * 0.6)),
  }));

  const sprites: Sprite[] = [];
  for (const node of graph.nodes) {
    sprites.push({
      key: `leaf:${node.oid}`,
      kind: 2,
      x: node.x,
      y: node.y + 4,
      size: 30,
      rotate: (seeded(`leaf:${node.oid}`) - 0.5) * 0.9,
      flip: seeded(`flip:${node.oid}`) < 0.5,
    });
    const branches = node.refs.filter((ref) => !ref.startsWith("tag: ")).sort();
    // The shared text/inspection layer retains EVERY ref, including large clusters.
    branches.slice(0, 3).forEach((ref, index, shown) => {
      const identity = `${graph.id}:${ref}`;
      sprites.push({
        key: `flower:${ref}`,
        kind: flowerVariant(identity),
        x: node.x + (index - (shown.length - 1) / 2) * 13,
        y: node.y - 4,
        size: 32,
        rotate: (seeded(`turn:${identity}`) - 0.5) * 0.5,
        flip: false,
      });
    });
    const tags = node.refs.filter((ref) => ref.startsWith("tag: ")).sort();
    tags.slice(0, 3).forEach((tag, index) => {
      sprites.push({
        key: `fruit:${tag}`,
        kind: 3,
        x: node.x + 16 + index * 7,
        y: node.y + 5 + index * 5,
        size: 25,
        rotate: (seeded(`fruit:${tag}`) - 0.5) * 0.4,
        flip: false,
      });
    });
  }

  // Ground each plant: a soft shadow under every lowest point, a commit with
  // no visible parent (at the end of its history tail, if it has one).
  const hasParent = new Set(graph.edges.map((e) => e.child));
  const grounds: Ground[] = [];
  for (const node of graph.nodes) {
    if (hasParent.has(node.oid)) continue;
    const tail = graph.tails.find((t) => t.child === node.oid);
    const at = tail ? tail.to : node;
    grounds.push({ key: node.oid, x: at.x, y: at.y + 6, width: 34 });
  }

  return { stems, knots, sprites, grounds };
}
