import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import atlasUrl from "./assets/botanical-atlas.png";
import {
  ATLAS_SIZE,
  botanicalScene,
  CELL_SIZE,
  HALO_COLOR,
  KNOT_COLOR,
  type Scene,
} from "./botanical.ts";
import { GraphSvg, graphWidth, type GraphSvgProps } from "./GraphSvg.tsx";
import { blendScenes, TRANSITION_MS, type Frame } from "./transition.ts";

/** One decoded atlas per page, shared by every plot and redraw. */
let loadedAtlas: HTMLImageElement | null = null;
let atlasLoading: Promise<HTMLImageElement> | null = null;
function loadAtlas(): Promise<HTMLImageElement> {
  atlasLoading ??= new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      loadedAtlas = image;
      resolve(image);
    };
    image.onerror = () => {
      // Allow a later attempt (e.g. after the service restarts).
      atlasLoading = null;
      reject(new Error("atlas failed to load"));
    };
    image.src = atlasUrl;
  });
  return atlasLoading;
}

const GROUND_COLOR = "rgba(38, 52, 24, 0.22)";

/** Whether motion is allowed: the OS preference and the app setting. */
function motionAllowed(): boolean {
  if (document.documentElement.classList.contains("reduce-motion"))
    return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The artwork frame for a scene: when the same repository's scene changes,
 * a brief transition from the previous one (unless motion is reduced).
 */
function useSceneFrame(scene: Scene, graphId: string): Frame {
  const shown = useRef<{ scene: Scene; id: string } | null>(null);
  const [animation, setAnimation] = useState<{
    from: Scene;
    to: Scene;
    t: number;
  } | null>(null);
  useEffect(() => {
    const previous = shown.current;
    shown.current = { scene, id: graphId };
    if (!previous || previous.id !== graphId || previous.scene === scene)
      return;
    // Reduced motion: the new scene shows at once (a stale animation is
    // ignored because it no longer targets the current scene).
    if (!motionAllowed()) return;
    const start = performance.now();
    let handle = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRANSITION_MS);
      setAnimation(t >= 1 ? null : { from: previous.scene, to: scene, t });
      if (t < 1) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [scene, graphId]);
  const settled = useMemo(() => blendScenes(null, scene, 1), [scene]);
  return animation && animation.to === scene
    ? blendScenes(animation.from, animation.to, animation.t)
    : settled;
}

/** Canvas artwork plus the same SVG hit/label layer used by the truth renderer. */
export function BotanicalGraph(
  props: GraphSvgProps & { compositor: "canvas" | "svg" },
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const artFailed = useCallback(() => {
    setFailed(true);
  }, []);
  const scene = useMemo(() => botanicalScene(props.graph), [props.graph]);
  const frame = useSceneFrame(scene, props.graph.id);
  // Parsed once per path string, not on every pan/zoom/animation frame.
  const paths = useRef(new Map<string, Path2D>());
  const width = props.width ?? graphWidth(props.graph);
  const height = props.height ?? props.graph.size.height;
  const transform = props.transform;
  const top = props.rows?.top ?? -Infinity;
  const bottom = props.rows?.bottom ?? Infinity;
  useEffect(() => {
    if (props.compositor !== "canvas") return;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let disposed = false;
    let atlas: HTMLImageElement | null = loadedAtlas;
    const path = (d: string) => {
      let p = paths.current.get(d);
      if (!p) {
        p = new Path2D(d);
        paths.current.set(d, p);
      }
      return p;
    };
    const draw = () => {
      if (disposed || document.hidden || !atlas) return;
      // Bound backing memory even for tall histories; interaction is vector based.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        8192 / Math.max(width, height),
        Math.sqrt(4_000_000 / (width * height)),
      );
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      // Resizing reallocates the backing store; only do it when it changes.
      if (element.width !== pixelWidth || element.height !== pixelHeight) {
        element.width = pixelWidth;
        element.height = pixelHeight;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixelWidth, pixelHeight);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      // FocusGraph supplies a controlled translate/scale string, never repository text.
      const values = transform
        ?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
        ?.map(Number);
      if (values?.length === 3) {
        ctx.translate(values[0] ?? 0, values[1] ?? 0);
        ctx.scale(values[2] ?? 1, values[2] ?? 1);
      }
      const near = (y: number, reach: number) =>
        y + reach >= top && y - reach <= bottom;
      ctx.fillStyle = GROUND_COLOR;
      for (const ground of frame.grounds) {
        if (!near(ground.y, 10)) continue;
        ctx.beginPath();
        ctx.ellipse(ground.x, ground.y, ground.width / 2, 5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.lineCap = "round";
      for (const stem of frame.stems) {
        if (stem.bottom < top || stem.top > bottom) continue;
        ctx.globalAlpha = stem.alpha;
        if (stem.dashed) {
          // Pale under-stroke separates crossings without introducing a junction.
          ctx.setLineDash([]);
          ctx.strokeStyle = HALO_COLOR;
          ctx.lineWidth = stem.width + 2.5;
          ctx.stroke(path(stem.halo));
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = stem.color;
          ctx.lineWidth = stem.width;
          ctx.stroke(path(stem.path));
        } else {
          ctx.fillStyle = HALO_COLOR;
          ctx.fill(path(stem.halo));
          ctx.fillStyle = stem.color;
          ctx.fill(path(stem.path));
        }
      }
      ctx.setLineDash([]);
      ctx.fillStyle = KNOT_COLOR;
      for (const knot of frame.knots) {
        if (!near(knot.y, knot.r)) continue;
        ctx.globalAlpha = knot.alpha;
        ctx.beginPath();
        ctx.arc(knot.x, knot.y, knot.r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const sprite of frame.sprites) {
        if (!near(sprite.y, sprite.size)) continue;
        const size = sprite.size * sprite.scale;
        ctx.globalAlpha = sprite.alpha;
        ctx.save();
        ctx.translate(sprite.x, sprite.y);
        ctx.rotate(sprite.rotate);
        if (sprite.flip) ctx.scale(-1, 1);
        ctx.drawImage(
          atlas,
          (sprite.kind % 2) * CELL_SIZE,
          Math.floor(sprite.kind / 2) * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
          -size / 2,
          -size / 2,
          size,
          size,
        );
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      element.dataset.ready = "true";
    };
    if (atlas) {
      // Pan, zoom, and animation re-run this effect every frame: draw synchronously.
      draw();
    } else {
      loadAtlas().then(
        (image) => {
          atlas = image;
          draw();
        },
        () => {
          if (!disposed) setFailed(true);
        },
      );
    }
    const redraw = () => {
      draw();
    };
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
    };
  }, [frame, top, bottom, width, height, transform, props.compositor]);

  if (failed) return <GraphSvg {...props} />;
  return (
    <div
      className="botanical-graph"
      style={{ width, height }}
      data-compositor={props.compositor}
    >
      {props.compositor === "canvas" ? (
        <canvas ref={canvas} style={{ width, height }} aria-hidden="true" />
      ) : (
        <svg
          className="botanical-art"
          width={width}
          height={height}
          aria-hidden="true"
        >
          <g transform={transform}>
            <BotanicalMarks
              frame={frame}
              top={top}
              bottom={bottom}
              onError={artFailed}
            />
          </g>
        </svg>
      )}
      <GraphSvg {...props} botanical />
    </div>
  );
}

const BotanicalMarks = memo(function BotanicalMarks({
  frame,
  top,
  bottom,
  onError,
}: {
  frame: Frame;
  top: number;
  bottom: number;
  onError: () => void;
}) {
  const near = (y: number, reach: number) =>
    y + reach >= top && y - reach <= bottom;
  return (
    <>
      {frame.grounds.map((ground) =>
        near(ground.y, 10) ? (
          <ellipse
            key={`ground-${ground.key}`}
            cx={ground.x}
            cy={ground.y}
            rx={ground.width / 2}
            ry={5}
            fill={GROUND_COLOR}
          />
        ) : null,
      )}
      {frame.stems.map((stem) =>
        stem.bottom < top || stem.top > bottom ? null : stem.dashed ? (
          <g
            key={stem.key}
            fill="none"
            strokeLinecap="round"
            opacity={stem.alpha}
          >
            <path
              d={stem.halo}
              stroke={HALO_COLOR}
              strokeWidth={stem.width + 2.5}
            />
            <path
              d={stem.path}
              stroke={stem.color}
              strokeWidth={stem.width}
              strokeDasharray="3 5"
            />
          </g>
        ) : (
          <g key={stem.key} opacity={stem.alpha}>
            <path d={stem.halo} fill={HALO_COLOR} />
            <path d={stem.path} fill={stem.color} />
          </g>
        ),
      )}
      {frame.knots.map((knot) =>
        near(knot.y, knot.r) ? (
          <circle
            key={`knot-${knot.key}`}
            cx={knot.x}
            cy={knot.y}
            r={knot.r}
            fill={KNOT_COLOR}
            opacity={knot.alpha}
          />
        ) : null,
      )}
      {frame.sprites.map((sprite) => {
        if (!near(sprite.y, sprite.size)) return null;
        const size = sprite.size * sprite.scale;
        const degrees = (sprite.rotate * 180) / Math.PI;
        return (
          <g
            key={sprite.key}
            opacity={sprite.alpha}
            transform={`translate(${String(sprite.x)} ${String(sprite.y)}) rotate(${String(degrees)})${sprite.flip ? " scale(-1 1)" : ""}`}
          >
            <svg
              x={-size / 2}
              y={-size / 2}
              width={size}
              height={size}
              viewBox={`${String((sprite.kind % 2) * CELL_SIZE)} ${String(Math.floor(sprite.kind / 2) * CELL_SIZE)} ${String(CELL_SIZE)} ${String(CELL_SIZE)}`}
            >
              <image
                href={atlasUrl}
                width={ATLAS_SIZE}
                height={ATLAS_SIZE}
                onError={onError}
              />
            </svg>
          </g>
        );
      })}
    </>
  );
});
