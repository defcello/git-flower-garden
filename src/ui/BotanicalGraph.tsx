import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import atlasUrl from "./assets/botanical-atlas.png";
import { ATLAS_SIZE, botanicalScene, CELL_SIZE } from "./botanical.ts";
import { GraphSvg, graphWidth, type GraphSvgProps } from "./GraphSvg.tsx";

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
  const width = props.width ?? graphWidth(props.graph);
  const height = props.height ?? props.graph.size.height;
  const transform = props.transform;
  useEffect(() => {
    if (props.compositor !== "canvas") return;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let disposed = false;
    const atlas = new Image();
    const draw = () => {
      if (disposed || document.hidden) return;
      // Bound backing memory even for tall histories; interaction is vector based.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        8192 / Math.max(width, height),
        Math.sqrt(4_000_000 / (width * height)),
      );
      element.width = Math.max(1, Math.round(width * ratio));
      element.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      // FocusGraph supplies a controlled translate/scale string, never repository text.
      const values = transform
        ?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
        ?.map(Number);
      if (values?.length === 3) {
        ctx.translate(values[0] ?? 0, values[1] ?? 0);
        ctx.scale(values[2] ?? 1, values[2] ?? 1);
      }
      ctx.lineCap = "round";
      for (const stem of scene.stems) {
        ctx.setLineDash(stem.dashed ? [3, 5] : []);
        const path = new Path2D(stem.path);
        // Pale under-stroke separates crossings without introducing a junction.
        ctx.strokeStyle = "#e0e9cf";
        ctx.lineWidth = stem.width + 2;
        ctx.stroke(path);
        ctx.strokeStyle = stem.color;
        ctx.lineWidth = stem.width;
        ctx.stroke(path);
      }
      for (const sprite of scene.sprites) {
        ctx.drawImage(
          atlas,
          (sprite.kind % 2) * CELL_SIZE,
          Math.floor(sprite.kind / 2) * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
          sprite.x - sprite.size / 2,
          sprite.y - sprite.size / 2,
          sprite.size,
          sprite.size,
        );
      }
      element.dataset.ready = "true";
    };
    atlas.onload = draw;
    atlas.onerror = () => {
      if (!disposed) setFailed(true);
    };
    atlas.src = atlasUrl;
    const redraw = () => {
      if (atlas.complete && atlas.naturalWidth > 0) draw();
    };
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
    };
  }, [scene, width, height, transform, props.compositor]);

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
            <BotanicalMarks scene={scene} onError={artFailed} />
          </g>
        </svg>
      )}
      <GraphSvg {...props} botanical />
    </div>
  );
}

const BotanicalMarks = memo(function BotanicalMarks({
  scene,
  onError,
}: {
  scene: ReturnType<typeof botanicalScene>;
  onError: () => void;
}) {
  return (
    <>
      {scene.stems.map((stem, index) => (
        <g
          key={index}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={stem.dashed ? "3 5" : undefined}
        >
          <path d={stem.path} stroke="#e0e9cf" strokeWidth={stem.width + 2} />
          <path d={stem.path} stroke={stem.color} strokeWidth={stem.width} />
        </g>
      ))}
      {scene.sprites.map((sprite, index) => (
        <svg
          key={index}
          x={sprite.x - sprite.size / 2}
          y={sprite.y - sprite.size / 2}
          width={sprite.size}
          height={sprite.size}
          viewBox={`${String((sprite.kind % 2) * CELL_SIZE)} ${String(Math.floor(sprite.kind / 2) * CELL_SIZE)} ${String(CELL_SIZE)} ${String(CELL_SIZE)}`}
        >
          <image
            href={atlasUrl}
            width={ATLAS_SIZE}
            height={ATLAS_SIZE}
            onError={onError}
          />
        </svg>
      ))}
    </>
  );
});
