import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import atlasUrl from "./assets/botanical-atlas.png";
import { ATLAS_SIZE, botanicalScene, CELL_SIZE } from "./botanical.ts";
import { GraphSvg, graphWidth, type GraphSvgProps } from "./GraphSvg.tsx";

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
  // Parsed once per scene, not on every pan/zoom frame.
  const paths = useMemo(
    () => scene.stems.map((stem) => new Path2D(stem.path)),
    [scene],
  );
  const top = props.rows?.top ?? -Infinity;
  const bottom = props.rows?.bottom ?? Infinity;
  const width = props.width ?? graphWidth(props.graph);
  const height = props.height ?? props.graph.size.height;
  const transform = props.transform;
  useEffect(() => {
    if (props.compositor !== "canvas") return;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let disposed = false;
    let atlas: HTMLImageElement | null = loadedAtlas;
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
      ctx.lineCap = "round";
      for (const [index, stem] of scene.stems.entries()) {
        if (stem.bottom < top || stem.top > bottom) continue;
        const path = paths[index];
        if (!path) continue;
        ctx.setLineDash(stem.dashed ? [3, 5] : []);
        // Pale under-stroke separates crossings without introducing a junction.
        ctx.strokeStyle = "#e0e9cf";
        ctx.lineWidth = stem.width + 2;
        ctx.stroke(path);
        ctx.strokeStyle = stem.color;
        ctx.lineWidth = stem.width;
        ctx.stroke(path);
      }
      for (const sprite of scene.sprites) {
        if (sprite.y + sprite.size < top || sprite.y - sprite.size > bottom)
          continue;
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
    if (atlas) {
      // Pan and zoom re-run this effect every frame: draw synchronously.
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
  }, [scene, paths, top, bottom, width, height, transform, props.compositor]);

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
              scene={scene}
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
  scene,
  top,
  bottom,
  onError,
}: {
  scene: ReturnType<typeof botanicalScene>;
  top: number;
  bottom: number;
  onError: () => void;
}) {
  const near = (y: number, reach: number) =>
    y + reach >= top && y - reach <= bottom;
  return (
    <>
      {scene.stems.map((stem, index) =>
        stem.bottom < top || stem.top > bottom ? null : (
          <g
            key={index}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={stem.dashed ? "3 5" : undefined}
          >
            <path d={stem.path} stroke="#e0e9cf" strokeWidth={stem.width + 2} />
            <path d={stem.path} stroke={stem.color} strokeWidth={stem.width} />
          </g>
        ),
      )}
      {scene.sprites.map((sprite, index) =>
        !near(sprite.y, sprite.size) ? null : (
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
        ),
      )}
    </>
  );
});
