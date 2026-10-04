/**
 * The garden's scene: sky, stars, Sun, Moon, and the relit ridge and hill,
 * behind the plants (ADR 0018). The GPU tier draws it with WebGL2 and
 * relights the ridge and hill in a shader (scene/gpu.ts); the software
 * tier draws it with Canvas 2D from layers relit in a worker. Only the
 * clouds move, drifting with the wind's speed while the plants sway, so
 * it draws when they have moved, the light, the lit art, or the window
 * changes, and never while the page is hidden. Decorative: hidden from
 * assistive technology and never a pointer target.
 *
 * Either tier draws the light the plants' art was lit for, never ahead of
 * it, so a frame never mixes two times of day.
 */
import { useEffect, useRef, useState } from "react";
import type { LightingState } from "../environment/lighting.ts";
import {
  gpuSupport,
  listenSway,
  preset,
  probingGpu,
  reportGpuFrame,
  useQuality,
  useWantsGpu,
} from "./motion.ts";
import { fitCanvas } from "./paint.ts";
import {
  requestLight,
  usePlantsOnGpu,
  useSceneArt,
  useShownLight,
  type LitArt,
  type SceneArt,
} from "./scene/client.ts";
import { LandscapeGpu } from "./scene/gpu.ts";
import { useGpu } from "./scene/useGpu.ts";
import {
  cloudLayer,
  cloudPlaces,
  rainbowLayer,
  type CloudRaster,
  type Raster,
  type SkyWeather,
} from "./scene/weather-sky.ts";
import { cloudDrift } from "../environment/weather-effects.ts";
import { cloudTravel, swayWind } from "./sway.ts";
import {
  DESIGN,
  lightKey,
  moonLight,
  moonShadow,
  MOON_COLOR,
  MOON_SILHOUETTE,
  MOON_UMBRA_COLOR,
  sceneLight,
  skyBodies,
  transform,
} from "./scene/view.ts";

const css = (c: readonly number[], a = 1) =>
  `rgb(${c.map((v) => String(Math.round(v * 255))).join(" ")} / ${a.toFixed(3)})`;

/** The Moon's disc with its phase and any eclipse, cached by lighting and size. */
let moonCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function moonSprite(
  s: readonly [number, number, number],
  shadow: readonly [number, number, number, number],
  r: number,
): HTMLCanvasElement {
  const size = Math.max(2, Math.ceil(r * 2.1));
  const key = `${[...s, ...shadow].map((v) => v.toFixed(3)).join()}:${String(size)}`;
  if (moonCache?.key === key) return moonCache.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = ((x + 0.5) / size) * 2.1 - 1.05;
        const dy = -(((y + 0.5) / size) * 2.1 - 1.05);
        const radius = Math.hypot(dx, dy);
        if (radius > 1.03) continue;
        const lit = moonLight(dx, dy, s);
        const edge = 1 - Math.min(1, Math.max(0, (radius - 0.97) / 0.06));
        const { umbra, dim } = moonShadow(dx, dy, shadow);
        const i = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) {
          const day = (MOON_COLOR[c] ?? 0) * (1 - dim);
          image.data[i + c] =
            (day + ((MOON_UMBRA_COLOR[c] ?? 0) - day) * umbra) * 255;
        }
        // Unlit parts let the sky through.
        image.data[i + 3] = edge * (0.3 + 0.7 * lit) * 255;
      }
    context.putImageData(image, 0, 0);
  }
  moonCache = { key, canvas };
  return canvas;
}

/** The sky's weather rasters for this canvas (scene/weather-sky.ts). */
function weatherRasters(
  element: HTMLCanvasElement,
  state: LightingState,
  weather: SkyWeather | null,
): { clouds: CloudRaster | null; rainbow: Raster | null } {
  const clouds =
    weather && cloudLayer(element.width, element.height, state, weather);
  const bow =
    weather && rainbowLayer(element.width, element.height, state, weather);
  element.dataset.clouds = String(Boolean(clouds));
  element.dataset.rainbow = String(Boolean(bow));
  return { clouds, rainbow: bow };
}

/** How far the clouds have drifted: by the sky's clock and while animating. */
function cloudOffset(weather: SkyWeather | null): number {
  if (weather === null) return 0;
  return cloudDrift(weather.effects, weather.minutes) + cloudTravel();
}

/**
 * Redraw the landscape as its clouds move: on the sway clock, whenever they
 * have moved half a canvas pixel. With no clouds, or while the plants rest
 * (Low, Static, reduced motion, a hidden page), nothing is drawn. Returns
 * a function to stop.
 */
function followClouds(
  element: HTMLCanvasElement,
  weather: SkyWeather | null,
  redraw: () => void,
  /** Milliseconds between redraws at least: each is costly on software WebGL. */
  interval = 0,
): () => void {
  const moving =
    weather !== null &&
    weather.effects.cloudCover > 0.02 &&
    weather.effects.windSpeed > 0;
  if (!moving) return () => undefined;
  let drawn = cloudTravel();
  let at = 0;
  const clock = listenSway((seconds) => {
    if (seconds === null) return;
    swayWind(seconds);
    const scale = transform(element.width, element.height).scale;
    if (Math.abs(cloudTravel() - drawn) * scale < 0.5) return;
    if (seconds * 1000 - at < interval) return;
    at = seconds * 1000;
    drawn = cloudTravel();
    redraw();
  });
  return clock.stop;
}

/** A canvas of the canvas's size, made once per element and kind. */
const layers = new WeakMap<
  HTMLCanvasElement,
  Map<string, { key: unknown[]; canvas: HTMLCanvasElement }>
>();
function layer(
  element: HTMLCanvasElement,
  kind: string,
  key: unknown[],
  paint: (g: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  let kinds = layers.get(element);
  if (!kinds) {
    kinds = new Map<string, { key: unknown[]; canvas: HTMLCanvasElement }>();
    layers.set(element, kinds);
  }
  const known = kinds.get(kind);
  if (
    known &&
    known.key.length === key.length &&
    known.key.every((v, i) => v === key[i])
  )
    return known.canvas;
  const canvas = known?.canvas ?? document.createElement("canvas");
  canvas.width = element.width;
  canvas.height = element.height;
  const g = canvas.getContext("2d");
  if (g) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    paint(g);
  }
  kinds.set(kind, { key, canvas });
  return canvas;
}

function draw(
  element: HTMLCanvasElement,
  state: LightingState,
  art: LitArt | null,
  weather: SkyWeather | null,
): void {
  const g = element.getContext("2d", { alpha: false });
  if (!g) return;
  fitCanvas(element, preset().pixelRatio);
  const W = element.width;
  const H = element.height;
  const t = transform(W, H);
  const weatherLayers = weatherRasters(element, state, weather);
  const clouds = weatherLayers.clouds;
  // With clouds, which move, what stays still is drawn once, in layers, so
  // each step of the clouds is a few copies; without, it is drawn directly.
  const layered = clouds !== null;
  if (layered)
    g.drawImage(
      layer(element, "sky", [W, H, state], (g) => {
        paintSky(g, state, W, H);
      }),
      0,
      0,
    );
  else paintSky(g, state, W, H);
  if (clouds)
    for (const x of cloudPlaces(W, H, cloudOffset(weather)))
      g.drawImage(clouds.canvas, x, 0, clouds.span, H);
  const lit = art !== null && art.ridge !== null && art.hill !== null;
  if (lit) {
    const paint = (g: CanvasRenderingContext2D, image: ImageBitmap) => {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(
        image,
        t.ox,
        t.oy,
        DESIGN.width * t.scale,
        DESIGN.height * t.scale,
      );
    };
    const show = (kind: string, image: ImageBitmap) => {
      if (layered)
        g.drawImage(
          layer(element, kind, [W, H, image], (g) => {
            paint(g, image);
          }),
          0,
          0,
        );
      else paint(g, image);
    };
    if (art.ridge) show("ridge", art.ridge);
    // The rain a rainbow shines in is nearer than the ridges.
    if (weatherLayers.rainbow) {
      // Light the rain sends back adds to what is behind it.
      g.globalCompositeOperation = "lighter";
      g.drawImage(weatherLayers.rainbow.canvas, 0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    }
    if (art.hill) show("hill", art.hill);
  }
  mark(element, state, art?.key, lit);
}

/** The sky behind the clouds: its gradient, the stars, the Sun and Moon. */
function paintSky(
  g: CanvasRenderingContext2D,
  state: LightingState,
  W: number,
  H: number,
): void {
  const t = transform(W, H);
  const sky = skyBodies(t, state);
  const gradient = g.createLinearGradient(0, 0, 0, sky.horizonY);
  gradient.addColorStop(0, css(state.sky.zenith));
  gradient.addColorStop(1, css(state.sky.horizon));
  g.fillStyle = gradient;
  g.fillRect(0, 0, W, H);
  for (const s of sky.stars) {
    g.fillStyle = `rgb(242 245 255 / ${s.a.toFixed(3)})`;
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    g.fill();
  }
  if (sky.sun !== null) {
    const { x, y, r, glow, alpha, visible, hole, corona } = sky.sun;
    const halo = g.createRadialGradient(x, y, 0, x, y, glow);
    const stops = 6;
    for (let i = 0; i <= stops; i++) {
      const f = i / stops;
      halo.addColorStop(
        f,
        css(state.sun.color, Math.pow(1 - f, 2) * 0.55 * alpha * visible),
      );
    }
    g.fillStyle = halo;
    g.fillRect(x - glow, y - glow, glow * 2, glow * 2);
    g.save();
    if (hole !== null) {
      // The Moon covers the disc: draw only outside it.
      g.beginPath();
      g.rect(0, 0, W, H);
      g.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
      g.clip("evenodd");
    }
    g.fillStyle = css(state.sun.color, alpha);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    if (hole !== null && corona > 0) {
      // As the GPU shader: falling off by e every 0.55 of the Moon's radius.
      const reach = hole.r * 4;
      const ring = g.createRadialGradient(
        hole.x,
        hole.y,
        hole.r,
        hole.x,
        hole.y,
        reach,
      );
      for (let i = 0; i <= stops; i++) {
        const f = i / stops;
        const k = Math.exp(-(f * (reach - hole.r)) / (0.55 * hole.r));
        ring.addColorStop(f, css(state.sun.color, k * 0.85 * corona * alpha));
      }
      g.fillStyle = ring;
      g.fillRect(hole.x - reach, hole.y - reach, reach * 2, reach * 2);
    }
    g.restore();
    if (hole !== null) {
      // The Moon's silhouette: where it covers the disc, whole at totality.
      g.save();
      if (corona <= 0) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.clip();
      }
      g.fillStyle = css(MOON_SILHOUETTE, alpha);
      g.beginPath();
      g.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  if (sky.moon !== null) {
    const size = sky.moon.r * 2.1;
    g.globalAlpha = sky.moon.alpha;
    g.drawImage(
      moonSprite(sky.moon.s, sky.moon.shadow, sky.moon.r),
      sky.moon.x - size / 2,
      sky.moon.y - size / 2,
      size,
      size,
    );
    g.globalAlpha = 1;
  }
}

/** Test and diagnostic attributes shared by both tiers. */
function mark(
  element: HTMLCanvasElement,
  state: LightingState,
  /** The light the art on screen was lit for; none before it exists. */
  artKey: string | undefined,
  lit: boolean,
): void {
  const sky = skyBodies(transform(element.width, element.height), state);
  element.dataset.sun = String(sky.sun !== null);
  element.dataset.moon = String(sky.moon !== null);
  element.dataset.stars = String(sky.stars.length > 0);
  element.dataset.lit = String(lit);
  // For tests: the light the sky was drawn for, and the light of the art.
  element.dataset.skyLight = lightKey(sceneLight(state));
  if (artKey !== undefined) element.dataset.artLight = artKey;
}

export function SceneCanvas({
  state,
  weather,
}: {
  state: LightingState;
  /** The sky's weather; null for a clear sky. */
  weather: SkyWeather | null;
}) {
  /** The GPU context is lost; Software draws until it is restored. */
  const [lost, setLost] = useState(false);
  /** The GPU tier could not start (no context, a shader or art failure). */
  const [failed, setFailed] = useState(false);
  // Static draws with Canvas 2D, like Software, but never animates.
  const wantsGpu = useWantsGpu() && !failed;
  const gpu = wantsGpu && !lost;
  const plantsOnGpu = usePlantsOnGpu();
  const scene = useSceneArt();
  const art = scene.state === "ready" ? scene.art : null;

  useEffect(() => {
    requestLight(state, gpu ? (plantsOnGpu ? "none" : "sprites") : "all");
  }, [state, gpu, plantsOnGpu]);

  // Draw the sky for the light the art was lit for, never ahead of it: the
  // canvas repaints only when a whole frame (sky and relit layers) is ready.
  const shown = useShownLight(state);
  return (
    <>
      {wantsGpu && (
        <GpuCanvas
          shown={shown}
          weather={weather}
          selfLit={plantsOnGpu}
          art={art}
          scene={scene}
          hidden={lost}
          onLost={setLost}
          onFail={setFailed}
        />
      )}
      {!gpu && (
        <SoftwareCanvas
          shown={shown}
          weather={weather}
          art={art}
          scene={scene}
        />
      )}
    </>
  );
}

function SoftwareCanvas({
  shown,
  weather,
  art,
  scene,
}: {
  shown: LightingState;
  weather: SkyWeather | null;
  art: LitArt | null;
  scene: SceneArt;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // A new preset may change the canvas's resolution.
  const quality = useQuality();
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () => {
      if (!document.hidden) draw(element, shown, art, weather);
    };
    redraw();
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    const stopClouds = followClouds(element, weather, redraw);
    return () => {
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
      stopClouds();
    };
  }, [shown, art, weather, quality]);

  return (
    <canvas
      ref={canvas}
      className="landscape-scene"
      data-tier="software"
      data-art={scene.state}
      data-light-ms={art ? art.lightMs.toFixed(0) : undefined}
    />
  );
}

/** The GPU tier's landscape, on its own WebGL2 context (scene/useGpu.ts). */
function GpuCanvas({
  shown,
  weather,
  selfLit,
  art,
  scene,
  hidden,
  onLost,
  onFail,
}: {
  shown: LightingState;
  weather: SkyWeather | null;
  /** The plants are on the GPU too: nothing waits for the worker. */
  selfLit: boolean;
  art: LitArt | null;
  scene: SceneArt;
  hidden: boolean;
  /** Both are state setters, so they never change. */
  onLost: (lost: boolean) => void;
  onFail: (failed: true) => void;
}) {
  const { canvas, renderer, version } = useGpu(
    LandscapeGpu.create,
    onLost,
    onFail,
  );
  const quality = useQuality();

  useEffect(() => {
    const element = canvas.current;
    if (!element || hidden) return;
    const redraw = () => {
      const gpu = renderer.current;
      if (document.hidden || gpu === null) return;
      fitCanvas(element, preset().pixelRatio);
      const timed = probingGpu("landscape");
      const start = performance.now();
      const rasters = weatherRasters(element, shown, weather);
      const lit = gpu.draw(shown, {
        ...rasters,
        cloudPlaces: cloudPlaces(
          element.width,
          element.height,
          cloudOffset(weather),
        ),
      });
      if (timed && lit) {
        gpu.finish();
        reportGpuFrame("landscape", performance.now() - start);
      }
      // With the plants on the GPU too, everything is lit for `shown`.
      mark(
        element,
        shown,
        selfLit ? lightKey(sceneLight(shown)) : art?.key,
        lit,
      );
    };
    redraw();
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    // Software WebGL (only by hand: Auto refuses it) relights the whole
    // landscape on the CPU for each step of the clouds.
    const stopClouds = followClouds(
      element,
      weather,
      redraw,
      gpuSupport() === "hardware" ? 0 : 500,
    );
    return () => {
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
      stopClouds();
    };
  }, [
    shown,
    weather,
    selfLit,
    art,
    hidden,
    canvas,
    renderer,
    version,
    quality,
  ]);

  return (
    <canvas
      ref={canvas}
      className={hidden ? "landscape-lost" : "landscape-scene"}
      hidden={hidden}
      data-tier="gpu"
      data-art={scene.state}
    />
  );
}
