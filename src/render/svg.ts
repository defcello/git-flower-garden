/**
 * Static technical SVG for a laid-out visible graph. Shapes and dash patterns,
 * not color alone, distinguish node and edge kinds. All repository text
 * (ref names, messages) is escaped: it is data, never markup.
 */
import type { VisibleGraph, VisibleNode } from "../core/visible-graph.ts";
import type { Layout, LayoutEdge } from "./layout.ts";

export interface SvgLabels {
  /** Commit OID -> ref labels shown beside the node, e.g. `main`, `origin/main`, `tag: v1`. */
  refs?: ReadonlyMap<string, readonly string[]>;
  /** Commit OID -> commit subject. */
  subjects?: ReadonlyMap<string, string>;
  title?: string;
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const TEXT_GAP = 14;
const LABEL_WIDTH = 420;
const LEGEND_HEIGHT = 96;

function edgePath(e: LayoutEdge): string {
  const { from, to } = e;
  if (e.detour !== undefined) {
    // Bulge sideways so the edge cannot be mistaken for passing through the
    // commits that sit between its ends in the same lane.
    const x = from.x + e.detour;
    return `M${String(from.x)} ${String(from.y)} C${String(x)} ${String(from.y)} ${String(x)} ${String(to.y)} ${String(to.x)} ${String(to.y)}`;
  }
  if (from.x === to.x)
    return `M${String(from.x)} ${String(from.y)} L${String(to.x)} ${String(to.y)}`;
  // Leave the child vertically, bend toward the parent's lane, arrive vertically.
  const midY = (from.y + to.y) / 2;
  return `M${String(from.x)} ${String(from.y)} C${String(from.x)} ${String(midY)} ${String(to.x)} ${String(midY)} ${String(to.x)} ${String(to.y)}`;
}

function nodeShape(node: VisibleNode, x: number, y: number): string {
  const r = node.reasons;
  const cls = r.includes("head")
    ? "head"
    : r.includes("recent")
      ? "recent"
      : r.includes("ancestor")
        ? "ancestor"
        : "other";
  let shape: string;
  if (cls === "ancestor" || (cls === "other" && r.includes("inspection"))) {
    // Hollow diamond: a required base or an inspected commit, not recent work.
    const d = 7;
    shape = `<path class="node ${cls}" d="M${String(x)} ${String(y - d)} L${String(x + d)} ${String(y)} L${String(x)} ${String(y + d)} L${String(x - d)} ${String(y)} Z"/>`;
  } else {
    shape = `<circle class="node ${cls}" cx="${String(x)}" cy="${String(y)}" r="${cls === "head" ? "7" : "5"}"/>`;
    if (cls === "head")
      shape += `<circle class="ring" cx="${String(x)}" cy="${String(y)}" r="10"/>`;
  }
  if (r.includes("worktree")) {
    shape += `<rect class="worktree" x="${String(x + 8)}" y="${String(y - 12)}" width="7" height="7"/>`;
  }
  if (node.boundary) {
    shape += `<path class="boundary" d="M${String(x - 6)} ${String(y + 12)} l4 -4 l4 4 l4 -4"/>`;
  }
  return shape;
}

export function renderSvg(
  graph: VisibleGraph,
  layout: Layout,
  labels: SvgLabels = {},
): string {
  const width = layout.width + LABEL_WIDTH;
  const height = layout.height + LEGEND_HEIGHT;
  const textX = layout.width + TEXT_GAP;
  const out: string[] = [];
  const title = labels.title ?? "Git history";
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-labelledby="t d">`,
    `<title id="t">${escapeXml(title)}</title>`,
    `<desc id="d">${escapeXml(
      `${String(graph.nodes.size)} visible commits of ${String(graph.reachableCount)} reachable. Parents are drawn below children.`,
    )}</desc>`,
    `<style>
      svg { background: #fbfaf7; font: 12px system-ui, sans-serif; }
      .edge { fill: none; stroke: #4a5a4f; stroke-width: 2; }
      .edge.collapsed { stroke-dasharray: 2 5; stroke-linecap: round; stroke-width: 2.5; }
      .tail { stroke: #4a5a4f; stroke-width: 2; stroke-dasharray: 2 5; stroke-linecap: round; }
      .tail.boundary { stroke-dasharray: none; stroke: #9a3b2a; }
      .node { stroke: #1f2a22; stroke-width: 1.5; }
      .node.head { fill: #2f7d4f; } .node.recent { fill: #7fb08a; }
      .node.ancestor, .node.other { fill: #fbfaf7; }
      .ring { fill: none; stroke: #2f7d4f; stroke-width: 1.5; }
      .worktree { fill: #c28a2c; stroke: #1f2a22; }
      .boundary { fill: none; stroke: #9a3b2a; stroke-width: 1.5; }
      .hidden-count { fill: #4a5a4f; font-size: 10px; }
      .badge rect { fill: #fbfaf7; stroke: #4a5a4f; stroke-dasharray: 2 2; }
      .badge text { fill: #1f2a22; font-size: 9px; text-anchor: middle; }
      .refs { fill: #1f2a22; font-weight: 600; } .subject { fill: #4a5a4f; }
      .legend { fill: #4a5a4f; }
    </style>`,
  );

  for (const e of layout.edges) {
    out.push(`<path class="edge ${e.kind}" d="${edgePath(e)}"/>`);
    if (e.kind === "collapsed") {
      // A count badge on the dashed edge just below the child, where the edge
      // still runs vertically in the child's own lane. Full text on hover.
      const x = e.from.x;
      const y = e.from.y + Math.min(18, (e.to.y - e.from.y) / 2);
      const count =
        e.hidden === null ? "…" : e.hidden > 999 ? "999+" : String(e.hidden);
      const text =
        e.hidden === null
          ? "Hidden ancestry: multiple paths"
          : `Hidden ancestry: ${String(e.hidden)} commit${e.hidden === 1 ? "" : "s"}`;
      const w = 8 + count.length * 6;
      out.push(
        `<g class="badge"><title>${escapeXml(text)}</title><rect x="${String(x - w / 2)}" y="${String(y - 7)}" width="${String(w)}" height="14" rx="7"/><text x="${String(x)}" y="${String(y + 3.5)}">${escapeXml(count)}</text></g>`,
      );
    }
  }
  for (const t of layout.tails) {
    out.push(
      `<line class="tail${t.boundary ? " boundary" : ""}" x1="${String(t.from.x)}" y1="${String(t.from.y)}" x2="${String(t.to.x)}" y2="${String(t.to.y)}"/>`,
    );
    const text = t.boundary
      ? "history missing (shallow or unavailable)"
      : t.hidden === null
        ? "older history: multiple paths"
        : `older history: ${String(t.hidden)} hidden`;
    out.push(
      `<text class="hidden-count" x="${String(t.to.x + 6)}" y="${String(t.to.y)}">${escapeXml(text)}</text>`,
    );
  }

  // Nodes, drawn in a stable order; text rows at the right, gitk-style.
  const byRowDesc = [...layout.nodes.values()].sort(
    (a, b) => b.row - a.row || a.lane - b.lane || (a.oid < b.oid ? -1 : 1),
  );
  for (const n of byRowDesc) {
    const node = graph.nodes.get(n.oid) as VisibleNode;
    const refs = labels.refs?.get(n.oid) ?? [];
    const subject = labels.subjects?.get(n.oid) ?? "";
    const short = n.oid.slice(0, 7);
    out.push(
      `<g class="commit" data-oid="${escapeXml(n.oid)}"><title>${escapeXml(`${n.oid}\n${subject}\nIncluded as: ${node.reasons.join(", ")}`)}</title>`,
      nodeShape(node, n.x, n.y),
      `<text x="${String(textX)}" y="${String(n.y + 4)}">`,
      refs.length > 0
        ? `<tspan class="refs">${escapeXml(refs.join(", "))} </tspan>`
        : "",
      `<tspan class="subject">${escapeXml(`${short} ${subject}`)}</tspan></text></g>`,
    );
  }

  const ly = layout.height + 18;
  out.push(
    `<g class="legend" transform="translate(12 ${String(ly)})">`,
    `<text y="0">Older commits are lower. Legend:</text>`,
    `<circle class="node head" cx="8" cy="18" r="7"/><circle class="ring" cx="8" cy="18" r="10"/><text x="24" y="22">branch head</text>`,
    `<circle class="node recent" cx="118" cy="18" r="5"/><text x="130" y="22">recent commit</text>`,
    `<path class="node ancestor" d="M228 11 L235 18 L228 25 L221 18 Z"/><text x="242" y="22">common ancestor</text>`,
    `<rect class="worktree" x="350" y="14" width="7" height="7"/><text x="362" y="22">worktree HEAD</text>`,
    `<line class="edge" x1="0" y1="44" x2="30" y2="44"/><text x="38" y="48">parent</text>`,
    `<line class="edge collapsed" x1="100" y1="44" x2="130" y2="44"/><text x="138" y="48">hidden ancestry; badge = hidden commits (… = multiple paths)</text>`,
    `<line class="tail boundary" x1="100" y1="66" x2="130" y2="66"/><text x="138" y="70">missing history (shallow or unavailable)</text>`,
    `</g></svg>`,
  );
  return out.join("\n");
}
