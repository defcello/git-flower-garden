/**
 * The garden's plants (ADR 0018): every hillside plant drawn from the
 * shared SceneDescription into one stage-sized canvas, back to front,
 * instead of one canvas per plot. The GPU tier draws them with WebGL2
 * (scene/plants-gpu.ts); what follows describes the software tier, which
 * the GPU tier matches. The drop shadow, the cyan
 * outline of the hovered or keyboard-focused plant, and wilting, which the
 * plots had from CSS filters, are drawn here too.
 *
 * Canvas filters and canvas-to-canvas copies are costly per frame, so each
 * plant's shadow and its whole look at rest are cached, and rebuilt only
 * when the light, the canvas size, the plant's history, or its highlight
 * changes. A swaying frame draws each cached shadow and paints the plant
 * over it directly. The highlighted plant and wilting plants hold still,
 * drawn from their cached look: the outline then fits exactly. Without
 * motion (Static, reduced motion, or sway stopped by the probe) every plant
 * is one cached image.
 *
 * The canvas also draws the plants' hidden-commit badges, so a plant in
 * front covers those of the plants behind it, as it did when each plot was
 * its own layer. The plots' SVG overlays stay above as the hit, focus, and
 * accessibility layer; this canvas is decorative and never a pointer
 * target.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LightingState } from "../environment/lighting.ts";
import type { Scene } from "./botanical.ts";
import {
  animates,
  FRAME_MS,
  gpuSupport,
  listenSway,
  useTier,
} from "./motion.ts";
import {
  badgeStyle,
  canvasFilters,
  castShadows,
  fitCanvas,
  MARGIN,
  OUTLINE,
  PathCache,
  paintBadges,
  paintBase,
  paintSprites,
  WILTING,
  type BadgeStyle,
  type Cast,
} from "./paint.ts";
import { setPlantsOnGpu, useSceneArt, type LitArt } from "./scene/client.ts";
import {
  gardenScene,
  toDesign,
  type PlantDescription,
  type PlantInput,
  type SceneDescription,
} from "./scene/description.ts";
import { PlantsGpu } from "./scene/plants-gpu.ts";
import { resolveTier } from "./scene/tier.ts";
import { useGpu } from "./scene/useGpu.ts";
import {
  DESIGN,
  lightKey,
  plantShadow,
  PLANT_SHADOW_RGB,
  sceneLight,
  type PlantShadow,
} from "./scene/view.ts";
import { swaySprites } from "./sway.ts";
import {
  blendScenes,
  settledFrame,
  TRANSITION_MS,
  type Frame,
} from "./transition.ts";

interface Growth {
  scene: Scene;
  /** The scene it grows from, while the transition runs. */
  from: Scene | null;
  start: number;
}

/**
 * The plot under the pointer, or else the one holding keyboard focus (as
 * the plots' CSS outlined them): its id, or null.
 */
function useHighlightedPlot(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const plots = [
        ...document.querySelectorAll<HTMLElement>(".garden-scene [data-plot]"),
      ];
      const plot =
        plots.find((p) => p.matches(":hover")) ??
        plots.find((p) => p.matches(":focus-visible, :has(:focus-visible)"));
      setId(plot?.dataset.plot ?? null);
    };
    const events = ["pointerover", "pointerout", "focusin", "focusout"];
    for (const event of events) document.addEventListener(event, update);
    update();
    return () => {
      for (const event of events) document.removeEventListener(event, update);
    };
  }, []);
  return id;
}

/**
 * The hillside's plants, drawn by the GPU tier (scene/plants-gpu.ts) or by
 * Canvas 2D (below), with the same growth and sway. `light` is the light
 * the scene shows (client.ts `useShownLight`).
 */
export function GardenCanvas({
  plants,
  light,
}: {
  plants: readonly PlantInput[];
  light: LightingState;
}) {
  const choice = useTier();
  /** The GPU context is lost; Software draws until it is restored. */
  const [lost, setLost] = useState(false);
  /** The GPU tier could not start (no context, a shader or art failure). */
  const [failed, setFailed] = useState(false);
  const wantsGpu = !failed && resolveTier(choice, gpuSupport()) === "gpu";
  const gpu = wantsGpu && !lost;
  useEffect(() => {
    // The worker then has no sprites to light for the hillside.
    setPlantsOnGpu(gpu);
    return () => {
      setPlantsOnGpu(false);
    };
  }, [gpu]);
  const highlighted = useHighlightedPlot();
  // `plants` keeps its identity while nothing drawn changes (App.tsx).
  const description = useMemo(
    () => gardenScene(plants, highlighted),
    [plants, highlighted],
  );
  const growth = useRef(new Map<string, Growth>());
  const attributes = {
    "aria-hidden": true,
    "data-highlight": highlighted ?? "",
    "data-plants": description.plants.length,
  } as const;
  return (
    <>
      {wantsGpu && (
        <GpuPlants
          description={description}
          growth={growth}
          light={light}
          hidden={lost}
          onLost={setLost}
          onFail={setFailed}
          attributes={attributes}
        />
      )}
      {!gpu && (
        <SoftwarePlants
          description={description}
          growth={growth}
          attributes={attributes}
        />
      )}
    </>
  );
}

type Attributes = Record<string, string | number | boolean>;

/**
 * Draw the plants now and whenever they move: growth into a changed
 * history (at most at the tier's frame rate), sway on the shared clock, a
 * resize, or the page showing again. Returns the cleanup.
 */
function runPlants(
  element: HTMLCanvasElement,
  description: SceneDescription,
  growth: RefObject<Map<string, Growth>>,
  paint: (
    frameOf: (plant: PlantDescription) => Frame,
    seconds: number | null,
  ) => void,
): () => void {
  // A plant whose history changed grows into its new scene.
  const now = performance.now();
  const next = new Map<string, Growth>();
  for (const plant of description.plants) {
    const before = growth.current.get(plant.id);
    next.set(
      plant.id,
      !before || before.scene === plant.scene
        ? (before ?? { scene: plant.scene, from: null, start: now })
        : {
            scene: plant.scene,
            from: animates() ? before.scene : null,
            start: now,
          },
    );
  }
  growth.current = next;
  const frameOf = (plant: PlantDescription, at: number): Frame => {
    const g = next.get(plant.id);
    if (!g?.from) return settledFrame(plant.scene);
    const t = (at - g.start) / TRANSITION_MS;
    if (t >= 1) {
      g.from = null;
      return settledFrame(plant.scene);
    }
    return blendScenes(g.from, g.scene, t);
  };
  const growing = () => [...next.values()].some((g) => g.from !== null);

  let seconds: number | null = null;
  const draw = () => {
    if (document.hidden) return;
    paint((plant) => frameOf(plant, performance.now()), seconds);
  };

  // Growth runs at most at the tier's frame rate.
  let handle = 0;
  let drawn = now;
  const step = (at: number) => {
    handle = 0;
    if (at - drawn >= FRAME_MS - 4) {
      drawn = at;
      draw();
    }
    if (growing()) handle = requestAnimationFrame(step);
    else draw();
  };
  if (growing()) handle = requestAnimationFrame(step);

  const clock = listenSway((at) => {
    seconds = at;
    draw();
  });
  seconds = clock.seconds;
  draw();
  const resize = new ResizeObserver(draw);
  resize.observe(element);
  document.addEventListener("visibilitychange", draw);
  return () => {
    cancelAnimationFrame(handle);
    clock.stop();
    resize.disconnect();
    document.removeEventListener("visibilitychange", draw);
  };
}

/** The plants drawn with Canvas 2D from sprites relit in the worker. */
function SoftwarePlants({
  description,
  growth,
  attributes,
}: {
  description: SceneDescription;
  growth: RefObject<Map<string, Growth>>;
  attributes: Attributes;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneArt = useSceneArt();
  const art = sceneArt.state === "ready" ? sceneArt.art : null;
  const painter = useRef<Painter | null>(null);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx || !art) return;
    painter.current ??= new Painter();
    const plants = painter.current;
    // Badges follow the panels' theme, which changes with the lit art.
    const badges = badgeStyle(element);
    return runPlants(element, description, growth, (frameOf, seconds) => {
      plants.paint(element, ctx, description, art, badges, frameOf, seconds);
    });
  }, [description, art, growth]);

  return (
    <canvas
      ref={canvas}
      className="garden-canvas"
      data-tier="software"
      {...attributes}
    />
  );
}

/** The plants drawn and lit by the GPU tier, on their own WebGL2 context. */
function GpuPlants({
  description,
  growth,
  light,
  hidden,
  onLost,
  onFail,
  attributes,
}: {
  description: SceneDescription;
  growth: RefObject<Map<string, Growth>>;
  light: LightingState;
  hidden: boolean;
  /** Both are state setters, so they never change. */
  onLost: (lost: boolean) => void;
  onFail: (failed: true) => void;
  attributes: Attributes;
}) {
  const { canvas, renderer, version } = useGpu(
    PlantsGpu.create,
    onLost,
    onFail,
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element || hidden) return;
    // Badges follow the panels' theme, which changes with the light.
    const badges = badgeStyle(element);
    const key = lightKey(sceneLight(light));
    return runPlants(element, description, growth, (frameOf, seconds) => {
      const gpu = renderer.current;
      if (gpu === null) return;
      const started = performance.now();
      fitCanvas(element);
      if (!gpu.paint(description, light, badges, frameOf, seconds)) return;
      element.dataset.ready = "true";
      element.dataset.artLight = key;
      // For measurements: script time of the last frame (not the GPU's).
      element.dataset.paintMs = (performance.now() - started).toFixed(1);
    });
  }, [description, light, hidden, growth, canvas, renderer, version]);

  return (
    <canvas
      ref={canvas}
      className={hidden ? "garden-canvas-lost" : "garden-canvas"}
      hidden={hidden}
      data-tier="gpu"
      {...attributes}
    />
  );
}

/** A plant's placement in device pixels. */
interface Placement {
  /** Device pixels per graph pixel. */
  k: number;
  /** Where the corner of the plant's bounds lands. */
  x: number;
  y: number;
}

/** A plant's cached images, drawn with their corner at (left, top). */
interface Cached {
  key: string;
  scene: Scene;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The drop shadow alone; null when there is none. */
  shadow: HTMLCanvasElement | null | undefined;
  /** The plant at rest with its shadow or outline, wilted if wilting. */
  rest: HTMLCanvasElement | undefined;
}

class Painter {
  private readonly paths = new PathCache();
  private readonly cache = new Map<string, Cached>();
  private readonly scratch = document.createElement("canvas");

  paint(
    element: HTMLCanvasElement,
    g: CanvasRenderingContext2D,
    description: SceneDescription,
    art: LitArt,
    badges: BadgeStyle,
    frameOf: (plant: PlantDescription) => Frame,
    seconds: number | null,
  ): void {
    const started = performance.now();
    fitCanvas(element);
    const W = element.width;
    const H = element.height;
    // The canvas is the 16:9 stage, so design pixels scale uniformly.
    const t = W / DESIGN.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const shadow = plantShadow(art.light);
    const seen = new Set<string>();

    for (const plant of description.plants) {
      seen.add(plant.id);
      const corner = toDesign(plant, plant.bounds.x, plant.bounds.y);
      const at = { k: plant.scale * t, x: corner.x * t, y: corner.y * t };
      const cached = this.cached(
        plant,
        at,
        art,
        shadow,
        `${String(W)}x${String(H)}`,
      );
      if (
        cached.left + cached.width < 0 ||
        cached.top + cached.height < 0 ||
        cached.left > W ||
        cached.top > H
      )
        continue;
      const frame = frameOf(plant);
      const growing = frame !== settledFrame(plant.scene);
      const still = seconds === null || plant.highlighted || plant.wilting;
      if (still && !growing) {
        cached.rest ??= this.rest(plant, at, cached, art, badges, shadow);
        g.drawImage(cached.rest, cached.left, cached.top);
        continue;
      }
      if (!plant.highlighted && !plant.wilting) {
        cached.shadow ??= this.shadow(plant, at, cached, art, badges, shadow);
        if (cached.shadow) g.drawImage(cached.shadow, cached.left, cached.top);
      }
      g.setTransform(
        at.k,
        0,
        0,
        at.k,
        at.x - plant.bounds.x * at.k,
        at.y - plant.bounds.y * at.k,
      );
      this.plant(g, frame, art, badges, still ? null : seconds);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (const id of this.cache.keys())
      if (!seen.has(id)) this.cache.delete(id);
    element.dataset.ready = "true";
    element.dataset.artLight = art.key;
    // For measurements: script time of the last frame (not the GPU's).
    element.dataset.paintMs = (performance.now() - started).toFixed(1);
  }

  private plant(
    g: CanvasRenderingContext2D,
    frame: Frame,
    art: LitArt,
    badges: BadgeStyle,
    seconds: number | null,
  ): void {
    paintBase(g, frame, art, this.paths);
    paintSprites(g, swaySprites(frame.sprites, seconds), art);
    // Over the art, as the plot's hit layer drew them, but in depth order.
    paintBadges(g, frame.badges, badges);
  }

  /** The plant's cache entry, emptied when what it shows has changed. */
  private cached(
    plant: PlantDescription,
    at: Placement,
    art: LitArt,
    shadow: PlantShadow | null,
    size: string,
  ): Cached {
    const key = [
      art.key,
      size,
      plant.highlighted,
      plant.wilting,
      shadow ? cast(shadow).color : "",
    ].join("|");
    const before = this.cache.get(plant.id);
    if (before?.key === key && before.scene === plant.scene) return before;
    const margin = Math.ceil(MARGIN * at.k) + 2;
    const entry: Cached = {
      key,
      scene: plant.scene,
      left: Math.floor(at.x) - margin,
      top: Math.floor(at.y) - margin,
      width:
        Math.ceil(plant.bounds.width * at.k + (at.x - Math.floor(at.x))) +
        1 +
        margin * 2,
      height:
        Math.ceil(plant.bounds.height * at.k + (at.y - Math.floor(at.y))) +
        1 +
        margin * 2,
      shadow: undefined,
      rest: undefined,
    };
    this.cache.set(plant.id, entry);
    return entry;
  }

  /** The plant at rest on the scratch canvas, placed as in its cache entry. */
  private atRest(
    plant: PlantDescription,
    at: Placement,
    cached: Cached,
    art: LitArt,
    badges: BadgeStyle,
  ): HTMLCanvasElement {
    const { scratch } = this;
    if (scratch.width < cached.width || scratch.height < cached.height) {
      scratch.width = Math.max(scratch.width, cached.width);
      scratch.height = Math.max(scratch.height, cached.height);
    }
    const g = scratch.getContext("2d");
    if (!g) return scratch;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cached.width, cached.height);
    g.setTransform(
      at.k,
      0,
      0,
      at.k,
      at.x - cached.left - plant.bounds.x * at.k,
      at.y - cached.top - plant.bounds.y * at.k,
    );
    this.plant(g, settledFrame(plant.scene), art, badges, null);
    return scratch;
  }

  private shadow(
    plant: PlantDescription,
    at: Placement,
    cached: Cached,
    art: LitArt,
    badges: BadgeStyle,
    shadow: PlantShadow | null,
  ): HTMLCanvasElement | null {
    if (!shadow || shadow.alpha <= 0) return null;
    const source = this.atRest(plant, at, cached, art, badges);
    const out = canvasOf(cached);
    const g = out.getContext("2d");
    if (g)
      castShadows(g, source, cached.width, cached.height, [cast(shadow)], at.k);
    return out;
  }

  private rest(
    plant: PlantDescription,
    at: Placement,
    cached: Cached,
    art: LitArt,
    badges: BadgeStyle,
    shadow: PlantShadow | null,
  ): HTMLCanvasElement {
    const source = this.atRest(plant, at, cached, art, badges);
    const out = canvasOf(cached);
    const g = out.getContext("2d");
    if (!g) return out;
    const casts: readonly Cast[] = plant.highlighted
      ? OUTLINE
      : shadow && shadow.alpha > 0
        ? [cast(shadow)]
        : [];
    const { width: w, height: h } = cached;
    // Safari before 18 has no canvas filters: shadows, but no wilting.
    if (canvasFilters(g)) {
      // The plots' CSS filters exactly: each drop shadow falls from what is
      // drawn so far, so the outline builds up. Filter lengths are device
      // pixels; the CSS ones scaled with the plant.
      const filters = casts.map(
        (c) =>
          `drop-shadow(${px(c.x * at.k)} ${px(c.y * at.k)} ${px(c.blur * at.k)} ${c.color})`,
      );
      if (plant.wilting) filters.unshift(WILTING);
      g.filter = filters.length > 0 ? filters.join(" ") : "none";
      g.drawImage(source, 0, 0, w, h, 0, 0, w, h);
      return out;
    }
    castShadows(g, source, w, h, casts, at.k);
    g.drawImage(source, 0, 0, w, h, 0, 0, w, h);
    return out;
  }
}

function canvasOf(cached: Cached): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = cached.width;
  out.height = cached.height;
  return out;
}

const px = (v: number) => `${v.toFixed(2)}px`;

function cast(shadow: PlantShadow): Cast {
  return {
    x: shadow.x,
    y: shadow.y,
    blur: shadow.blur,
    color: `rgb(${PLANT_SHADOW_RGB} / ${shadow.alpha.toFixed(3)})`,
  };
}
