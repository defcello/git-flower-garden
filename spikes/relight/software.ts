/**
 * The software tier of the spike: Canvas 2D with keyframed lighting (ADR
 * 0018). Each layer is pre-lit once per keyframe with the same `shade` the
 * GPU runs; at runtime the keyframes are blended and tinted into cached
 * layers, rebuilt only when the light changes, and the frame is composited
 * with drawImage.
 */
import type { LightingState } from "../../src/environment/lighting.ts";
import {
  decodeNormal,
  type LayerArt,
  type NormalSource,
  type Pixels,
} from "./art.ts";
import type { Art, Options } from "./gpu.ts";
import { keyframeStates, keyframeWeights } from "./scene.ts";
import {
  lightParams,
  shade,
  type LightParams,
  LAYERS,
  type Adjustments,
  type LayerLight,
} from "./shading.ts";
import {
  layerQuad,
  moonLight,
  MOON_COLOR,
  shadows,
  skyBodies,
  spriteQuads,
  transform,
  type Quad,
} from "./view.ts";

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) =>
  Math.pow(i / 255, 2.2),
);
const SRGB_STEPS = 4096;
const TO_SRGB = Uint8ClampedArray.from({ length: SRGB_STEPS + 1 }, (_, i) =>
  Math.round(Math.pow(i / SRGB_STEPS, 1 / 2.2) * 255),
);

function canvasOf(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  return context;
}

/** Pre-light one layer for one keyframe on the CPU. */
function bake(
  albedo: Pixels,
  normals: Pixels,
  p: LightParams,
  light: LayerLight,
): OffscreenCanvas {
  const { width, height, data } = albedo;
  const out = new ImageData(width, height);
  const o = out.data;
  const n = { x: 0, y: 0, z: 1 };
  const a: [number, number, number] = [0, 0, 0];
  const lit: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha === 0) continue;
    a[0] = TO_LINEAR[data[i] ?? 0] ?? 0;
    a[1] = TO_LINEAR[data[i + 1] ?? 0] ?? 0;
    a[2] = TO_LINEAR[data[i + 2] ?? 0] ?? 0;
    decodeNormal(normals.data, i, n);
    shade(a, n, p, light, lit);
    for (let c = 0; c < 3; c++)
      o[i + c] =
        TO_SRGB[
          Math.round(Math.min(1, Math.max(0, lit[c] ?? 0)) * SRGB_STEPS)
        ] ?? 0;
    o[i + 3] = alpha;
  }
  const canvas = canvasOf(width, height);
  context2d(canvas).putImageData(out, 0, 0);
  return canvas;
}

/** How much light a state brings (luminance): the basis of the runtime tint. */
function level(p: LightParams): number {
  const weights = [0.2126, 0.7152, 0.0722];
  return weights.reduce(
    (sum, w, c) =>
      sum +
      w *
        ((p.ambient[c] ?? 0) * 0.9 +
          (p.sun[c] ?? 0) * 0.6 +
          (p.moon[c] ?? 0) * 0.6),
    0,
  );
}

interface BakedLayer {
  keys: OffscreenCanvas[];
  cache: OffscreenCanvas;
  size: Pixels;
}

export class SoftwareTier {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #art: Art;
  #baked = "";
  #layers: Record<keyof Art, BakedLayer> | null = null;
  #cacheKey = "";
  #moon: OffscreenCanvas = canvasOf(1, 1);
  #moonKey = "";
  /** Milliseconds spent on the last keyframe bake and cache rebuild. */
  bakeMs = 0;
  rebuildMs = 0;
  rebuilds = 0;

  constructor(canvas: HTMLCanvasElement, art: Art) {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("no 2d context");
    this.#canvas = canvas;
    this.#context = context;
    this.#art = art;
  }

  /** Development-time work in production (a script, ADR 0018); here, at load. */
  #bake(
    normals: NormalSource,
    adjust: Adjustments,
  ): Record<keyof Art, BakedLayer> {
    const start = performance.now();
    const params = keyframeStates.map((s) => lightParams(s, adjust));
    const layer = (art: LayerArt, light: LayerLight): BakedLayer => {
      const map = art.normals[normals] ?? art.normals.derived;
      return {
        keys: params.map((p) => bake(art.albedo, map, p, light)),
        cache: canvasOf(art.albedo.width, art.albedo.height),
        size: art.albedo,
      };
    };
    const layers = {
      ridge: layer(this.#art.ridge, LAYERS.ridge),
      hill: layer(this.#art.hill, LAYERS.hill),
      sprites: layer(this.#art.sprites, LAYERS.sprites),
    };
    this.bakeMs = performance.now() - start;
    this.#cacheKey = "";
    return layers;
  }

  /** Blend keyframes and darken, into each layer's cache, when the light changed. */
  #rebuild(
    layers: Record<keyof Art, BakedLayer>,
    state: LightingState,
    adjust: Adjustments,
  ): void {
    const weights = keyframeWeights(state);
    const current = level(lightParams(state, adjust));
    const blended = keyframeStates
      .map((s) => level(lightParams(s, adjust)))
      .reduce((sum, l, k) => sum + (weights[k] ?? 0) * l, 0);
    // A brightness-only tint: Canvas "multiply" would bleed a colored tint
    // into semi-transparent edges, while darkening with "source-atop" black
    // is exact. The keyframes already carry the hue of their light.
    const tint = Math.min(1, current / Math.max(1e-4, blended));
    const key = [...weights, tint].map((v) => v.toFixed(3)).join();
    if (key === this.#cacheKey) return;
    const start = performance.now();
    this.#cacheKey = key;
    // The cache is sRGB; darken by the tint's sRGB equivalent.
    const darken = 1 - Math.pow(tint, 1 / 2.2);
    for (const layer of Object.values(layers)) {
      const g = context2d(layer.cache);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, layer.cache.width, layer.cache.height);
      g.globalCompositeOperation = "lighter";
      weights.forEach((w, k) => {
        const source = layer.keys[k];
        if (w <= 0.001 || source === undefined) return;
        g.globalAlpha = w;
        g.drawImage(source, 0, 0);
      });
      if (darken > 0.001) {
        g.globalCompositeOperation = "source-atop";
        g.globalAlpha = darken;
        g.fillStyle = "#000";
        g.fillRect(0, 0, layer.cache.width, layer.cache.height);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
    }
    this.rebuilds++;
    this.rebuildMs = performance.now() - start;
  }

  #moonSprite(s: [number, number, number], r: number): OffscreenCanvas {
    const size = Math.max(2, Math.ceil(r * 2.1));
    const key = `${s.map((v) => v.toFixed(3)).join()}:${String(size)}`;
    if (key === this.#moonKey) return this.#moon;
    this.#moonKey = key;
    const image = new ImageData(size, size);
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
        // Unlit parts let the sky through, as the shader's mix does.
        image.data[i + 3] = edge * (0.3 + 0.7 * lit) * 255;
      }
    this.#moon = canvasOf(size, size);
    context2d(this.#moon).putImageData(image, 0, 0);
    return this.#moon;
  }

  draw(state: LightingState, options: Options): void {
    const baked = `${options.normals}:${String(options.adjust.fill)}:${String(options.adjust.translucency)}`;
    if (this.#layers === null || this.#baked !== baked) {
      this.#layers = this.#bake(options.normals, options.adjust);
      this.#baked = baked;
    }
    const layers = this.#layers;
    this.#rebuild(layers, state, options.adjust);

    const g = this.#context;
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    const t = transform(W, H);
    const css = (c: readonly number[], a = 1) =>
      `rgb(${c.map((v) => String(Math.round(v * 255))).join(" ")} / ${a.toFixed(3)})`;

    // Sky, as the GPU tier draws it.
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
      const sprite = this.#moonSprite(sky.moon.s, sky.moon.r);
      g.globalAlpha = sky.moon.alpha;
      const size = sky.moon.r * 2.1;
      g.drawImage(
        sprite,
        sky.moon.x - size / 2,
        sky.moon.y - size / 2,
        size,
        size,
      );
      g.globalAlpha = 1;
    }

    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const blit = (layer: BakedLayer, q: Quad) => {
      g.drawImage(layer.cache, q.sx, q.sy, q.sw, q.sh, q.x, q.y, q.w, q.h);
    };
    blit(layers.ridge, layerQuad(t, layers.ridge.size));
    blit(layers.hill, layerQuad(t, layers.hill.size));
    for (const s of shadows(t, state, options.inspect)) {
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.angle);
      g.scale(s.rx, s.ry);
      const soft = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      soft.addColorStop(0, `rgb(5 10 8 / ${s.alpha.toFixed(3)})`);
      soft.addColorStop(0.35, `rgb(5 10 8 / ${s.alpha.toFixed(3)})`);
      soft.addColorStop(1, "rgb(5 10 8 / 0)");
      g.fillStyle = soft;
      g.beginPath();
      g.arc(0, 0, 1, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    for (const q of spriteQuads(t, layers.sprites.size, options.inspect))
      blit(layers.sprites, q);
  }
}
