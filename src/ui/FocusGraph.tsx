import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { GraphJson, GraphNodeJson } from "../api/types.ts";
import { BotanicalGraph } from "./BotanicalGraph.tsx";
import type { Renderer } from "./botanical.ts";
import { GraphSvg, graphWidth } from "./GraphSvg.tsx";

const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
/** At least this much of the drawing stays inside the viewport while panning. */
const KEEP_VISIBLE = 80;
const DRAG_THRESHOLD = 4;

interface Camera {
  scale: number;
  x: number;
  y: number;
}

interface FocusGraphProps {
  renderer: Renderer;
  graph: GraphJson;
  label: string;
  selectedOid: string | null;
  onHover: (node: GraphNodeJson | null, event?: React.PointerEvent) => void;
  onSelect: (oid: string) => void;
  exitButton: React.ReactNode;
}

/** Camera that fits the whole drawing, centered horizontally, under the controls. */
function framing(
  size: { width: number; height: number },
  gw: number,
  gh: number,
): Camera {
  const scale = clamp(
    Math.min(1.5, (size.width - 32) / gw, (size.height - 72) / gh),
    MIN_SCALE,
    MAX_SCALE,
  );
  return { scale, x: Math.max(16, (size.width - gw * scale) / 2), y: 64 };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Focused repository with bounded pan and zoom. The camera is kept across
 * live updates (no jumps); "Fit" re-frames on request, and commits that land
 * above the visible area are announced rather than scrolled to.
 */
export function FocusGraph(props: FocusGraphProps) {
  const { graph } = props;
  const Drawing = props.renderer === "technical" ? GraphSvg : BotanicalGraph;
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  // Null until the container is first measured; the tree is then framed once
  // and later graph updates keep the camera where the user left it.
  const [camera, setCamera] = useState<Camera | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    camera: Camera;
    moved: boolean;
    id: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const gw = graphWidth(graph);
  const gh = graph.size.height;

  const bound = useCallback(
    (c: Camera): Camera => ({
      scale: c.scale,
      x: clamp(c.x, KEEP_VISIBLE - gw * c.scale, size.width - KEEP_VISIBLE),
      y: clamp(c.y, KEEP_VISIBLE - gh * c.scale, size.height - KEEP_VISIBLE),
    }),
    [gw, gh, size],
  );

  const fit = useCallback(() => {
    setCamera(framing(size, gw, gh));
  }, [gw, gh, size]);

  // The observer reports the initial size too, so framing happens in its
  // callback, never with the placeholder size.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const measured = { width: el.clientWidth, height: el.clientHeight };
      setSize(measured);
      setCamera((c) => c ?? framing(measured, gw, gh));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [gw, gh]);

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      setCamera((c) => {
        if (!c) return c;
        const scale = clamp(c.scale * factor, MIN_SCALE, MAX_SCALE);
        const k = scale / c.scale;
        return bound({ scale, x: px - (px - c.x) * k, y: py - (py - c.y) * k });
      });
    },
    [bound],
  );

  // Wheel zoom needs a non-passive listener to prevent page scrolling.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(
        event.deltaY < 0 ? 1.15 : 1 / 1.15,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [zoomAt]);

  const cam = camera ?? { scale: 1, x: 16, y: 64 };
  const above = graph.nodes.filter((n) => n.y * cam.scale + cam.y < 0).length;
  // The exit button sits in the same conceptual place as the garden's "+": centered above the tree.
  const exitLeft = clamp(
    cam.x + (graph.size.width / 2) * cam.scale - 22,
    8,
    size.width - 52,
  );

  return (
    <div className="focus-graph-wrap">
      <div className="toolbar" role="toolbar" aria-label="Graph view">
        <button
          type="button"
          onClick={() => {
            zoomAt(1.25, size.width / 2, size.height / 2);
          }}
        >
          Zoom in
        </button>
        <button
          type="button"
          onClick={() => {
            zoomAt(1 / 1.25, size.width / 2, size.height / 2);
          }}
        >
          Zoom out
        </button>
        <button type="button" onClick={fit}>
          Fit
        </button>
      </div>
      <div
        ref={container}
        className={`focus-graph${camera === null ? " unframed" : ""}`}
        data-framed={camera === null ? "false" : "true"}
        data-scale={cam.scale.toFixed(3)}
        data-x={cam.x.toFixed(1)}
        data-y={cam.y.toFixed(1)}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("button"))
            return;
          drag.current = {
            startX: event.clientX,
            startY: event.clientY,
            camera: cam,
            moved: false,
            id: event.pointerId,
          };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || d.id !== event.pointerId) return;
          // A release outside the window never reaches us; with no button
          // held, the drag is over rather than continuing on hover.
          if (event.pointerType === "mouse" && event.buttons === 0) {
            drag.current = null;
            return;
          }
          const dx = event.clientX - d.startX;
          const dy = event.clientY - d.startY;
          if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          if (!d.moved) {
            d.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          setCamera(
            bound({
              scale: d.camera.scale,
              x: d.camera.x + dx,
              y: d.camera.y + dy,
            }),
          );
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          if (d?.moved) {
            suppressClick.current = true;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onClickCapture={(event) => {
          // A drag that ends on a commit must not also select it.
          if (suppressClick.current) {
            suppressClick.current = false;
            event.stopPropagation();
          }
        }}
      >
        <div className="exit-slot" style={{ left: exitLeft }}>
          {props.exitButton}
        </div>
        {above > 0 && (
          <button type="button" className="offscreen" onClick={fit}>
            {above} commit{above === 1 ? "" : "s"} above · Fit
          </button>
        )}
        <Drawing
          compositor={props.renderer === "svg" ? "svg" : "canvas"}
          graph={graph}
          label={props.label}
          selectedOid={props.selectedOid}
          width={size.width}
          height={size.height}
          transform={`translate(${String(cam.x)} ${String(cam.y)}) scale(${String(cam.scale)})`}
          onHover={props.onHover}
          onSelect={props.onSelect}
        />
      </div>
    </div>
  );
}
