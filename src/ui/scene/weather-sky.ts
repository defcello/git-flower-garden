/**
 * The weather in the sky (ADR 0018 step 5): clouds between the Sun and Moon
 * and the mountains, and a rainbow added in front of the far ridges (the
 * rain is nearer than they are) and behind the hill. Each is one raster
 * that serves both tiers: Software draws it, the GPU tier uploads it as a
 * texture, so their skies match. A raster changes only with the light, the
 * weather, the minute (clouds drift), or the window, never per frame.
 */
import type { Color, LightingState } from "../../environment/lighting.ts";
import { rainbowAt } from "../../environment/rainbow.ts";
import {
  CLOUD_ASPECT,
  cloudColors,
  cloudField,
  rainbow,
  type WeatherEffects,
} from "../../environment/weather-effects.ts";
import {
  DESIGN,
  HORIZON,
  RAINBOW_GROUND,
  rainbowAngle,
  rainbowCentre,
  toCanvas,
  transform,
} from "./view.ts";

export interface SkyWeather {
  effects: WeatherEffects;
  /** Minutes since the epoch at the shown instant: the clouds' drift. */
  minutes: number;
}

/** A raster and the key naming what is in it (uploads skip equal keys). */
export interface Raster {
  canvas: HTMLCanvasElement;
  key: string;
}

const css = (c: Color, a: number) =>
  `rgb(${c.map((v) => String(Math.round(Math.min(1, Math.max(0, v)) * 255))).join(" ")} / ${a.toFixed(3)})`;

/** One cached canvas per kind of raster. */
function cached() {
  let entry: Raster | null = null;
  return (
    key: string,
    width: number,
    height: number,
    paint: (g: CanvasRenderingContext2D) => void,
  ): Raster | null => {
    if (entry?.key === key) return entry;
    const canvas = entry?.canvas ?? document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, width, height);
    paint(g);
    entry = { canvas, key };
    return entry;
  };
}

const cloudCache = cached();
const rainbowCache = cached();

/** The clouds at canvas size, or null for a clear sky. */
export function cloudLayer(
  width: number,
  height: number,
  state: LightingState,
  weather: SkyWeather,
): Raster | null {
  const w = weather.effects;
  const minutes = Math.floor(weather.minutes);
  const { puffs, deck } = cloudField(w, minutes);
  if (puffs.length === 0 && deck === 0) return null;
  const colors = cloudColors(state, w);
  const key = JSON.stringify([
    "clouds",
    width,
    height,
    minutes,
    w,
    colors.top.map((v) => Math.round(v * 255)),
    colors.base.map((v) => Math.round(v * 255)),
  ]);
  return cloudCache(key, width, height, (g) => {
    const t = transform(width, height);
    if (deck > 0) {
      // Stratus: an even grey sheet, thinning toward the horizon, and on
      // down behind the ridges so no clear band shows between.
      const horizonY = t.oy + DESIGN.height * HORIZON * t.scale;
      const mid: Color = [
        (colors.base[0] + colors.top[0]) / 2,
        (colors.base[1] + colors.top[1]) / 2,
        (colors.base[2] + colors.top[2]) / 2,
      ];
      const sheet = g.createLinearGradient(0, 0, 0, horizonY);
      sheet.addColorStop(0, css(mid, 0.92 * deck));
      sheet.addColorStop(1, css(colors.top, 0.6 * deck));
      g.fillStyle = sheet;
      g.fillRect(0, 0, width, height);
    }
    // Undersides first, lit tops over them. Each puff is faint on its own,
    // so overlapping puffs build a cloud's body with no visible edges.
    const sorted = [...puffs].sort((a, b) => a.shade - b.shade);
    for (const puff of sorted) {
      const p = toCanvas(t, puff.x, puff.y);
      const r = puff.r * t.scale;
      const tone: Color = [
        colors.base[0] + (colors.top[0] - colors.base[0]) * puff.shade,
        colors.base[1] + (colors.top[1] - colors.base[1]) * puff.shade,
        colors.base[2] + (colors.top[2] - colors.base[2]) * puff.shade,
      ];
      g.save();
      g.translate(p.x, p.y);
      g.scale(CLOUD_ASPECT, 1);
      // Lit from above: the bright centre sits high in the puff.
      const fill = g.createRadialGradient(0, -r * 0.2, 0, 0, 0, r);
      const a = colors.alpha * 0.5;
      for (const [f, k] of [
        [0, 1],
        [0.3, 0.85],
        [0.6, 0.45],
        [0.85, 0.12],
        [1, 0],
      ] as const)
        fill.addColorStop(f, css(tone, a * k));
      g.fillStyle = fill;
      g.fillRect(-r, -r, r * 2, r * 2);
      g.restore();
    }
  });
}

/** The rainbow raster's width at most: the bow is smooth, so it is scaled up. */
const RAINBOW_WIDTH = 960;

/**
 * The rainbow, to be added to the scene (it is light the rain sends back),
 * or null when none may be seen. Each pixel shows the optical profile
 * (rainbow.ts) at its angle from the bow's centre, opposite the Sun, so
 * where the bow stands follows from the Sun. It stands on the ground
 * behind the hill, round, at the scale that keeps its top at the true
 * height (view.ts `RAINBOW_SCALE`), so its lower half is never seen.
 */
export function rainbowLayer(
  width: number,
  height: number,
  state: LightingState,
  weather: SkyWeather,
): Raster | null {
  const bow = rainbow(state, weather.effects);
  if (bow === null) return null;
  const scale = Math.min(1, RAINBOW_WIDTH / width);
  const rw = Math.max(1, Math.round(width * scale));
  const rh = Math.max(1, Math.round(height * scale));
  const key = JSON.stringify([
    "rainbow",
    rw,
    rh,
    // To about 0.1°: under a pixel at 1080p, so it is redrawn about once
    // a minute as the Sun moves.
    [bow.antisolar.u * 1000, bow.antisolar.altitude * 10].map((v) =>
      Math.round(v),
    ),
    bow.strength.toFixed(3),
    bow.tint.map((v) => v.toFixed(3)),
  ]);
  return rainbowCache(key, rw, rh, (g) => {
    const t = transform(width, height);
    const image = g.createImageData(rw, rh);
    const data = image.data;
    const rgb: number[] = [0, 0, 0];
    const centre = rainbowCentre(bow.antisolar);
    const gain = bow.tint.map((v) => v * bow.strength * 255);
    for (let py = 0; py < rh; py++) {
      const y = ((py + 0.5) / scale - t.oy) / t.scale;
      // Rain meets the ground: nothing below it.
      if (y > RAINBOW_GROUND) break;
      for (let px = 0; px < rw; px++) {
        const x = ((px + 0.5) / scale - t.ox) / t.scale;
        rainbowAt(rainbowAngle(x, y, centre), rgb);
        const i = (py * rw + px) * 4;
        for (let c = 0; c < 3; c++)
          data[i + c] = Math.max(0, (rgb[c] ?? 0) * (gain[c] ?? 0));
        data[i + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
  });
}
