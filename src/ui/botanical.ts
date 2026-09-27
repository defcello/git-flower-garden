import type { GraphJson } from "../api/types.ts";
import { edgePath } from "./edge-path.ts";

export type Renderer = "technical" | "canvas" | "svg";
export type Lighting = "day" | "dawn" | "dusk" | "night";
export interface Stem {
  path: string;
  /** Vertical extent, for skipping off-screen stems. */
  top: number;
  bottom: number;
  width: number;
  color: string;
  dashed: boolean;
}
export interface Sprite {
  kind: number;
  x: number;
  y: number;
  size: number;
}
// Measured source dimensions, not the requested generation dimensions.
export const ATLAS_SIZE = 1254;
export const CELL_SIZE = ATLAS_SIZE / 2;

/** Ref-based seed: moving a head must not change its flower family. */
export function flowerVariant(identity: string): number {
  let hash = 2166136261;
  for (const char of identity)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 2;
}

/** Both compositors consume this exact geometry; decoration cannot add ancestry. */
export function botanicalScene(graph: GraphJson) {
  const stems: Stem[] = graph.edges.map((edge) => ({
    path: edgePath(edge),
    top: Math.min(edge.from.y, edge.to.y),
    bottom: Math.max(edge.from.y, edge.to.y),
    width: Math.min(
      6,
      Math.max(2.5, 2.5 + (edge.to.y / graph.size.height) * 3),
    ),
    color: "#456b39",
    dashed: edge.kind === "collapsed",
  }));
  for (const tail of graph.tails) {
    stems.push({
      path: `M${String(tail.from.x)} ${String(tail.from.y)} L${String(tail.to.x)} ${String(tail.to.y)}`,
      top: Math.min(tail.from.y, tail.to.y),
      bottom: Math.max(tail.from.y, tail.to.y),
      width: 2.5,
      color: tail.boundary ? "#9a3b2a" : "#456b39",
      dashed: !tail.boundary,
    });
  }
  const sprites: Sprite[] = [];
  for (const node of graph.nodes) {
    sprites.push({ kind: 2, x: node.x, y: node.y + 4, size: 30 });
    const branches = node.refs.filter((ref) => !ref.startsWith("tag: ")).sort();
    // The shared text/inspection layer retains EVERY ref, including large clusters.
    branches.slice(0, 3).forEach((ref, index, shown) => {
      sprites.push({
        kind: flowerVariant(`${graph.id}:${ref}`),
        x: node.x + (index - (shown.length - 1) / 2) * 13,
        y: node.y - 4,
        size: 32,
      });
    });
    if (node.refs.some((ref) => ref.startsWith("tag: "))) {
      sprites.push({ kind: 3, x: node.x + 16, y: node.y + 5, size: 25 });
    }
  }
  return { stems, sprites };
}
