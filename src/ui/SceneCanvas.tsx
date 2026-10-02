/**
 * The garden's scene: sky, stars, Sun, Moon, and the relit ridge and hill,
 * behind the plants (ADR 0018). The GPU tier draws it with WebGL2 and
 * relights the ridge and hill in a shader (scene/gpu.ts); the software
 * tier draws it with Canvas 2D from layers relit in a worker. Nothing moves
 * yet, so it draws only when the light, the lit art, or the window
 * changes, and never while the page is hidden. Decorative: hidden from
 * assistive technology and never a pointer target.
 *
 * Either tier draws the light the plants' art was lit for, never ahead of
 * it, so a frame never mixes two times of day.
 */
import { useEffect, useRef, useState } from "react";
import type { LightingState } from "../environment/lighting.ts";
import {
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
  rainbowLayer,
  type Raster,
  type SkyWeather,
} from "./scene/weather-sky.ts";
import {
  DESIGN,
  lightKey,
  moonLight,
  MOON_COLOR,
  sceneLight,
  skyBodies,
  transform,
} from "./scene/view.ts";

const css = (c: readonly number[], a = 1) =>
  `rgb(${c.map((v) => String(Math.round(v * 255))).join(" ")} / ${a.toFixed(3)})`;

/** The Moon's disc with its phase, cached by lighting and size. */
let moonCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function moonSprite(
  s: readonly [number, number, number],
  r: number,
): HTMLCanvasElement {
  const size = Math.max(2, Math.ceil(r * 2.1));
  const key = `${s.map((v) => v.toFixed(3)).join()}:${String(size)}`;
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
        const i = (y * size + x) * 4;
        image.data[i] = MOON_COLOR[0] * 255;
        image.data[i + 1] = MOON_COLOR[1] * 255;
        image.data[i + 2] = MOON_COLOR[2] * 255;
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
): { clouds: Raster | null; rainbow: Raster | null } {
  const clouds =
    weather && cloudLayer(element.width, element.height, state, weather);
  const bow =
    weather && rainbowLayer(element.width, element.height, state, weather);
  element.dataset.clouds = String(Boolean(clouds));
  element.dataset.rainbow = String(Boolean(bow));
  return { clouds, rainbow: bow };
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
    const { x, y, r, glow, alpha } = sky.sun;
    const halo = g.createRadialGradient(x, y, 0, x, y, glow);
    const stops = 6;
    for (let i = 0; i <= stops; i++) {
      const f = i / stops;
      halo.addColorStop(
        f,
        css(state.sun.color, Math.pow(1 - f, 2) * 0.55 * alpha),
      );
    }
    g.fillStyle = halo;
    g.fillRect(x - glow, y - glow, glow * 2, glow * 2);
    g.fillStyle = css(state.sun.color, alpha);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  if (sky.moon !== null) {
    const size = sky.moon.r * 2.1;
    g.globalAlpha = sky.moon.alpha;
    g.drawImage(
      moonSprite(sky.moon.s, sky.moon.r),
      sky.moon.x - size / 2,
      sky.moon.y - size / 2,
      size,
      size,
    );
    g.globalAlpha = 1;
  }
  const weatherLayers = weatherRasters(element, state, weather);
  if (weatherLayers.clouds) g.drawImage(weatherLayers.clouds.canvas, 0, 0);
  const lit = art !== null && art.ridge !== null && art.hill !== null;
  if (lit) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const w = DESIGN.width * t.scale;
    const h = DESIGN.height * t.scale;
    if (art.ridge) g.drawImage(art.ridge, t.ox, t.oy, w, h);
    // The rain a rainbow shines in is nearer than the ridges.
    if (weatherLayers.rainbow) {
      // Light the rain sends back adds to what is behind it.
      g.globalCompositeOperation = "lighter";
      g.drawImage(weatherLayers.rainbow.canvas, 0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    }
    if (art.hill) g.drawImage(art.hill, t.ox, t.oy, w, h);
  }
  mark(element, state, art?.key, lit);
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
    return () => {
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
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
      const lit = gpu.draw(shown, weatherRasters(element, shown, weather));
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
    return () => {
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
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
