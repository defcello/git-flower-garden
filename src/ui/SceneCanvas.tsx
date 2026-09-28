/**
 * The garden's scene in the software tier (ADR 0018, step 3): sky, stars,
 * Sun, Moon, and the relit ridge and hill, drawn with Canvas 2D behind the
 * plants. Nothing moves yet, so it draws only when the light, the lit art,
 * or the window changes, and never while the page is hidden. Decorative:
 * hidden from assistive technology and never a pointer target.
 */
import { useEffect, useRef } from "react";
import type { LightingState } from "../environment/lighting.ts";
import { requestLight, useSceneArt, type LitArt } from "./scene/client.ts";
import {
  DESIGN,
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

function draw(
  element: HTMLCanvasElement,
  state: LightingState,
  art: LitArt | null,
): void {
  const g = element.getContext("2d", { alpha: false });
  if (!g) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  // The canvas fills the 16:9 stage (styles.css), so nothing is cropped.
  const W = Math.max(1, Math.round(element.clientWidth * ratio));
  const H = Math.max(1, Math.round(element.clientHeight * ratio));
  if (element.width !== W || element.height !== H) {
    element.width = W;
    element.height = H;
  }
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
  const lit = art !== null && art.ridge !== null && art.hill !== null;
  if (lit) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const w = DESIGN.width * t.scale;
    const h = DESIGN.height * t.scale;
    for (const layer of [art.ridge, art.hill])
      if (layer) g.drawImage(layer, t.ox, t.oy, w, h);
  }

  element.dataset.sun = String(sky.sun !== null);
  element.dataset.moon = String(sky.moon !== null);
  element.dataset.stars = String(sky.stars.length > 0);
  element.dataset.lit = String(lit);
}

export function SceneCanvas({ state }: { state: LightingState }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useSceneArt();
  const art = scene.state === "ready" ? scene.art : null;

  useEffect(() => {
    requestLight(sceneLight(state));
  }, [state]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () => {
      if (!document.hidden) draw(element, state, art);
    };
    redraw();
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    return () => {
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
    };
  }, [state, art]);

  return (
    <canvas
      ref={canvas}
      className="landscape-scene"
      data-art={scene.state}
      data-light-ms={art ? art.lightMs.toFixed(0) : undefined}
    />
  );
}
