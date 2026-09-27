import { memo } from "react";
import type { GraphJson, GraphNodeJson } from "../api/types.ts";
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
      className={`graph${props.botanical ? " botanical-overlay" : ""}`}
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={`${props.label}: ${String(graph.nodes.length)} commits shown of ${String(graph.reachableCount)}. Older commits are lower.`}
    >
      <g transform={props.transform}>
        <GraphMarks
          graph={graph}
          selectedOid={selectedOid}
          onHover={props.onHover}
          onSelect={props.onSelect}
        />
      </g>
    </svg>
  );
}

// Camera updates change only the enclosing transform, not thousands of marks.
const GraphMarks = memo(function GraphMarks(
  props: Pick<GraphSvgProps, "graph" | "selectedOid" | "onHover" | "onSelect">,
) {
  const { graph, selectedOid } = props;
  const textX = graph.size.width + TEXT_GAP;
  return (
    <>
      {graph.edges.map((e) => (
        <path
          key={`${e.child}-${e.parent}-${e.kind}`}
          className={`edge ${e.kind}`}
          d={edgePath(e)}
        />
      ))}
      {graph.edges
        .filter((e) => e.kind === "collapsed")
        .map((e) => {
          const y = e.from.y + Math.min(18, (e.to.y - e.from.y) / 2);
          const count =
            e.hidden === null
              ? "…"
              : e.hidden > 999
                ? "999+"
                : String(e.hidden);
          const w = 8 + count.length * 6;
          return (
            <g
              key={`badge-${e.child}-${e.parent}`}
              className="badge"
              data-hidden={e.hidden ?? "multiple"}
            >
              <title>{hiddenText(e.hidden)}</title>
              <rect
                x={e.from.x - w / 2}
                y={y - 7}
                width={w}
                height={14}
                rx={7}
              />
              <text x={e.from.x} y={y + 3.5}>
                {count}
              </text>
            </g>
          );
        })}
      {graph.tails.map((t) => (
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
      {graph.nodes.map((n) => (
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
