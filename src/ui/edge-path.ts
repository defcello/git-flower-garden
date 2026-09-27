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
