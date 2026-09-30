import { memo } from "react";
import type { GraphJson, GraphNodeJson } from "../api/types.ts";
import { BADGE_HEIGHT, collapsedBadge } from "./botanical.ts";
import { edgePath } from "./edge-path.ts";
import { hiddenText, shortOid } from "./format.ts";

export const LABEL_WIDTH = 460;
const ROW_HIT = 30;
const TEXT_GAP = 14;

export interface GraphSvgProps {
  botanical?: boolean;
  graph: GraphJson;
  label: string;
  selectedOid: string | null;
  /** Pan/zoom transform for the drawing (focus view); identity when omitted. */
  transform?: string;
  /**
   * Vertical range of the drawing (graph coordinates) to render; marks
   * entirely outside it are skipped. Everything is drawn when omitted.
   */
  rows?: { top: number; bottom: number };
  /** Hide commit text (focus view zoomed out below readable size). */
  far?: boolean;
  width?: number;
  height?: number;
  onHover: (node: GraphNodeJson | null, event?: React.PointerEvent) => void;
  onSelect: (oid: string) => void;
}

export function graphWidth(graph: GraphJson): number {
  return graph.size.width + LABEL_WIDTH;
}

/** Node glyph: ringed disc = head, disc = recent, hollow diamond = ancestor or inspected. */
function Glyph({ node }: { node: GraphNodeJson }) {
  const { x, y, reasons } = node;
  const head = reasons.includes("head");
  const recent = reasons.includes("recent");
  if (!head && !recent) {
    const d = 7;
    return (
      <path
        className={`node ${reasons.includes("ancestor") ? "ancestor" : "other"}`}
        d={`M${String(x)} ${String(y - d)} L${String(x + d)} ${String(y)} L${String(x)} ${String(y + d)} L${String(x - d)} ${String(y)} Z`}
      />
    );
  }
  return (
    <>
      <circle
        className={`node ${head ? "head" : "recent"}`}
        cx={x}
        cy={y}
        r={head ? 7 : 5}
      />
      {head && <circle className="ring" cx={x} cy={y} r={10} />}
    </>
  );
}

export function GraphSvg(props: GraphSvgProps) {
  const { graph, selectedOid } = props;
  const width = props.width ?? graphWidth(graph);
  const height = props.height ?? graph.size.height;
  return (
    <svg
      className={`graph${props.botanical ? " botanical-overlay" : ""}${props.far ? " far" : ""}`}
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={`${props.label}: ${String(graph.nodes.length)} commits shown of ${String(graph.reachableCount)}. Older commits are lower.`}
    >
      <g transform={props.transform}>
        <GraphMarks
          graph={graph}
          top={props.rows?.top ?? -Infinity}
          bottom={props.rows?.bottom ?? Infinity}
          selectedOid={selectedOid}
          onHover={props.onHover}
          onSelect={props.onSelect}
        />
      </g>
    </svg>
  );
}

// Camera updates change only the enclosing transform, not thousands of marks.
// Off-screen rows are skipped: the browser repaints only what is near view.
const GraphMarks = memo(function GraphMarks(
  props: Pick<
    GraphSvgProps,
    "graph" | "selectedOid" | "onHover" | "onSelect"
  > & { top: number; bottom: number },
) {
  const { graph, selectedOid, top, bottom } = props;
  const textX = graph.size.width + TEXT_GAP;
  const spans = (a: number, b: number) =>
    Math.max(a, b) >= top && Math.min(a, b) <= bottom;
  const edges = graph.edges.filter((e) => spans(e.from.y, e.to.y));
  const tails = graph.tails.filter((t) => spans(t.from.y, t.to.y));
  const nodes = graph.nodes.filter((n) => spans(n.y - ROW_HIT, n.y + ROW_HIT));
  return (
    <>
      {edges.map((e) => (
        <path
          key={`${e.child}-${e.parent}-${e.kind}`}
          className={`edge ${e.kind}`}
          d={edgePath(e)}
        />
      ))}
      {edges
        .filter((e) => e.kind === "collapsed")
        .map((e) => {
          const badge = collapsedBadge(e);
          return (
            <g
              key={`badge-${e.child}-${e.parent}`}
              className="badge"
              data-hidden={e.hidden ?? "multiple"}
            >
              <title>{hiddenText(e.hidden)}</title>
              <rect
                x={badge.x - badge.width / 2}
                y={badge.y - BADGE_HEIGHT / 2}
                width={badge.width}
                height={BADGE_HEIGHT}
                rx={BADGE_HEIGHT / 2}
              />
              <text x={badge.x} y={badge.y + 3.5}>
                {badge.text}
              </text>
            </g>
          );
        })}
      {tails.map((t) => (
        <g
          key={`tail-${t.child}-${String(t.boundary)}`}
          className={`tail${t.boundary ? " boundary" : ""}`}
        >
          <title>
            {t.boundary
              ? "History missing (shallow clone or unavailable objects)"
              : hiddenText(t.hidden)}
          </title>
          <line x1={t.from.x} y1={t.from.y} x2={t.to.x} y2={t.to.y} />
          {t.boundary && (
            <path
              d={`M${String(t.to.x - 6)} ${String(t.to.y)} l4 -4 l4 4 l4 -4`}
              className="boundary-mark"
            />
          )}
        </g>
      ))}
      {nodes.map((n) => (
        <g
          key={n.oid}
          className={`commit${n.oid === selectedOid ? " selected" : ""}`}
          data-oid={n.oid}
          onPointerEnter={(event) => {
            props.onHover(n, event);
          }}
          onPointerMove={(event) => {
            props.onHover(n, event);
          }}
          onPointerLeave={() => {
            props.onHover(null);
          }}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect(n.oid);
          }}
        >
          <rect
            className="hit"
            x={0}
            y={n.y - ROW_HIT / 2}
            width={textX + LABEL_WIDTH}
            height={ROW_HIT}
          />
          {n.oid === selectedOid && (
            <circle className="selection" cx={n.x} cy={n.y} r={14} />
          )}
          <Glyph node={n} />
          {n.worktrees.length > 0 && (
            <rect
              className="worktree"
              x={n.x + 8}
              y={n.y - 12}
              width={7}
              height={7}
            />
          )}
          {n.boundary && (
            <path
              className="boundary-mark"
              d={`M${String(n.x - 6)} ${String(n.y + 12)} l4 -4 l4 4 l4 -4`}
            />
          )}
          <text x={textX} y={n.y + 4}>
            {n.refs.length > 0 && (
              <tspan className="refs">{n.refs.join(", ")} </tspan>
            )}
            <tspan className="oid">{shortOid(n.oid)} </tspan>
            <tspan className="subject">{n.subject}</tspan>
          </text>
        </g>
      ))}
    </>
  );
});
