import type { GraphEdgeJson } from "../api/types.ts";

export function edgePath(e: GraphEdgeJson): string {
  const { from, to } = e;
  if (e.detour !== undefined) {
    const x = from.x + e.detour;
    return `M${String(from.x)} ${String(from.y)} C${String(x)} ${String(from.y)} ${String(x)} ${String(to.y)} ${String(to.x)} ${String(to.y)}`;
  }
  if (from.x === to.x)
    return `M${String(from.x)} ${String(from.y)} L${String(to.x)} ${String(to.y)}`;
  const midY = (from.y + to.y) / 2;
  return `M${String(from.x)} ${String(from.y)} C${String(from.x)} ${String(midY)} ${String(to.x)} ${String(midY)} ${String(to.x)} ${String(to.y)}`;
}

type Point = { x: number; y: number };

/**
 * The same curve as edgePath, as cubic control points (a straight edge has
 * its controls on the line). The endpoints are always the edge's own.
 */
export function edgeCurve(e: GraphEdgeJson): [Point, Point, Point, Point] {
  const { from, to } = e;
  if (e.detour !== undefined) {
    const x = from.x + e.detour;
    return [from, { x, y: from.y }, { x, y: to.y }, to];
  }
  if (from.x === to.x) {
    const third = (to.y - from.y) / 3;
    return [
      from,
      { x: from.x, y: from.y + third },
      { x: to.x, y: to.y - third },
      to,
    ];
  }
  const midY = (from.y + to.y) / 2;
  return [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
}
