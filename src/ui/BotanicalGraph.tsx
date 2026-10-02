import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ATLAS_SIZE,
  botanicalScene,
  CELL_SIZE,
  HALO_COLOR,
  KNOT_COLOR,
  type Scene,
} from "./botanical.ts";
import { GraphSvg, graphWidth, type GraphSvgProps } from "./GraphSvg.tsx";
import { useSceneArt, type Channel, type LitArt } from "./scene/client.ts";
import { animates, frameMs, listenSway } from "./motion.ts";
import { swaySprites } from "./sway.ts";
import { blendScenes, TRANSITION_MS, type Frame } from "./transition.ts";
import { GROUND_COLOR, PathCache, paintBase, paintSprites } from "./paint.ts";

/**
 * The artwork frame for a scene: when the same repository's scene changes,
 * a brief transition from the previous one (unless motion is reduced or
 * the tier is Static), at most at the software tier's frame rate.
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
    // Reduced motion or Static: the new scene shows at once (a stale
    // animation is ignored because it no longer targets the current scene).
    if (!animates()) return;
    const start = performance.now();
    let handle = 0;
    let drawn = start;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRANSITION_MS);
      if (t >= 1 || now - drawn >= frameMs() - 4) {
        drawn = now;
        setAnimation(t >= 1 ? null : { from: previous.scene, to: scene, t });
      }
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

/**
 * Canvas artwork plus the same SVG hit/label layer used by the truth
 * renderer. Sprites come from the scene's relit atlases (ADR 0018); if they
 * cannot be made, the plant falls back to the technical drawing.
 */
export function BotanicalGraph(
  props: GraphSvgProps & {
    compositor: "canvas" | "svg";
    /** Which light the artwork takes: the sky's, or daylight for inspection. */
    light?: Channel;
    /** Whether leaves and flowers sway in the wind (the garden, not focus). */
    sway?: boolean;
    /**
     * Only the hit and label layer: the garden's scene canvas draws this
     * plant's art (GardenCanvas.tsx).
     */
    artless?: boolean;
  },
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneArt = useSceneArt(props.light);
  const art = sceneArt.state === "ready" ? sceneArt.art : null;
  const scene = useMemo(() => botanicalScene(props.graph), [props.graph]);
  const frame = useSceneFrame(scene, props.graph.id);
  const paths = useRef(new PathCache());
  const width = props.width ?? graphWidth(props.graph);
  const height = props.height ?? props.graph.size.height;
  const transform = props.transform;
  const top = props.rows?.top ?? -Infinity;
  const bottom = props.rows?.bottom ?? Infinity;
  const sway = props.sway === true;
  const artless = props.artless === true;
  useEffect(() => {
    if (props.compositor !== "canvas" || artless) return;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    if (!art) return;
    // A hillside plant is shrunk to its place with a CSS transform: draw at
    // the size it is shown, not its layout size, so every frame (and every
    // sway frame) moves no more pixels than the screen shows. Measured when
    // this effect runs or the window changes, never per sway frame; eighths
    // keep small changes from reallocating the canvas.
    const shownScale = () => {
      const shown = element.getBoundingClientRect().width / width;
      return shown > 0 ? Math.min(1, Math.ceil(shown * 8) / 8) : 1;
    };
    let fit = shownScale();
    const near = (y: number, reach: number) =>
      y + reach >= top && y - reach <= bottom;
    // FocusGraph supplies a controlled translate/scale string, never repository text.
    const values = transform
      ?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
      ?.map(Number);
    const place = (g: CanvasRenderingContext2D, ratio: number) => {
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (values?.length === 3) {
        g.translate(values[0] ?? 0, values[1] ?? 0);
        g.scale(values[2] ?? 1, values[2] ?? 1);
      }
    };
    const draw = (seconds: number | null) => {
      if (document.hidden) return;
      // Bound backing memory even for tall histories; interaction is vector based.
      const ratio = Math.min(
        (window.devicePixelRatio || 1) * fit,
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
      place(ctx, ratio);
      paintBase(ctx, frame, art, paths.current, near);
      paintSprites(ctx, swaySprites(frame.sprites, seconds), art, near);
      ctx.globalAlpha = 1;
      element.dataset.ready = "true";
    };
    // Pan, zoom, animation, and relighting re-run this effect: draw
    // synchronously. Sway redraws from the shared clock, without React.
    let seconds: number | null = null;
    const clock = sway
      ? listenSway((now) => {
          seconds = now;
          draw(now);
        })
      : null;
    seconds = clock?.seconds ?? null;
    draw(seconds);
    const redraw = () => {
      fit = shownScale();
      draw(seconds);
    };
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    return () => {
      clock?.stop();
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
    };
  }, [
    frame,
    top,
    bottom,
    width,
    height,
    transform,
    props.compositor,
    art,
    sway,
    artless,
  ]);

  if (sceneArt.state === "failed") return <GraphSvg {...props} />;
  return (
    <div
      className="botanical-graph"
      style={{ width, height }}
      data-compositor={props.compositor}
    >
      {artless ? null : props.compositor === "canvas" ? (
        <canvas ref={canvas} style={{ width, height }} aria-hidden="true" />
      ) : (
        <svg
          className="botanical-art"
          width={width}
          height={height}
          aria-hidden="true"
        >
          <g transform={transform}>
            {art && (
              <BotanicalMarks
                frame={frame}
                top={top}
                bottom={bottom}
                art={art}
                sway={sway}
              />
            )}
          </g>
        </svg>
      )}
      <GraphSvg {...props} botanical />
    </div>
  );
}

/** The sway clock as React state, for the SVG compositor's marks. */
function useSwayClock(enabled: boolean): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const clock = listenSway(setSeconds);
    return clock.stop;
  }, [enabled]);
  return enabled ? seconds : null;
}

const BotanicalMarks = memo(function BotanicalMarks({
  frame,
  top,
  bottom,
  art,
  sway,
}: {
  frame: Frame;
  top: number;
  bottom: number;
  art: LitArt;
  sway: boolean;
}) {
  const seconds = useSwayClock(sway);
  const near = (y: number, reach: number) =>
    y + reach >= top && y - reach <= bottom;
  const lit = (color: string) => art.palette[color] ?? color;
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
              stroke={lit(HALO_COLOR)}
              strokeWidth={stem.width + 2.5}
            />
            <path
              d={stem.path}
              stroke={lit(stem.color)}
              strokeWidth={stem.width}
              strokeDasharray="3 5"
            />
          </g>
        ) : (
          <g key={stem.key} opacity={stem.alpha}>
            <path d={stem.halo} fill={lit(HALO_COLOR)} />
            <path d={stem.path} fill={lit(stem.color)} />
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
            fill={lit(KNOT_COLOR)}
            opacity={knot.alpha}
          />
        ) : null,
      )}
      {swaySprites(frame.sprites, seconds).map((sprite) => {
        if (!near(sprite.y, sprite.size)) return null;
        const size = sprite.size * sprite.scale;
        const degrees = (sprite.rotate * 180) / Math.PI;
        return (
          <g
            key={sprite.key}
            opacity={sprite.alpha}
            transform={`translate(${String(sprite.x)} ${String(sprite.y)}) rotate(${String(degrees)})`}
          >
            <svg
              x={-size / 2}
              y={-size / 2}
              width={size}
              height={size}
              viewBox={`${String((sprite.kind % 2) * CELL_SIZE)} ${String(Math.floor(sprite.kind / 2) * CELL_SIZE)} ${String(CELL_SIZE)} ${String(CELL_SIZE)}`}
            >
              <image
                href={sprite.flip ? art.spritesMirroredUrl : art.spritesUrl}
                width={ATLAS_SIZE}
                height={ATLAS_SIZE}
              />
            </svg>
          </g>
        );
      })}
    </>
  );
});
