/**
 * The software tier's lighting (ADR 0018, step 3): every texel of a layer
 * lit on the CPU with the same `shade` as the GPU tier, from its flat-lit
 * albedo, normal map, and translucency map. Run in a worker whenever the
 * light changes meaningfully, never per frame. Pure: typed arrays only, so
 * it runs and is tested in Node as well as in a browser worker.
 */
import type { Vector3 } from "../../environment/lighting.ts";
import { shade, type LayerLight, type LightParams } from "./shading.ts";

/** RGBA, 8 bits per channel, straight (not premultiplied) alpha. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A layer ready to light: albedo, unit normals, and optional translucency. */
export interface LayerSource {
  /** RGBA; alpha snapped at both ends (see `cleanAlpha`). */
  albedo: Pixels;
  /** RGB-encoded unit normals (x right, y up, z out); outside the silhouette, (0, 0, 1). */
  normals: Pixels;
  /** 0..255 per texel, 0 outside the silhouette; null uses the layer's constant. */
  translucency: Uint8Array | null;
}

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) =>
  Math.pow(i / 255, 2.2),
);
const TO_UNIT = Float32Array.from({ length: 256 }, (_, i) => i / 127.5 - 1);
const TO_FRACTION = Float32Array.from({ length: 256 }, (_, i) => i / 255);
const SRGB_STEPS = 4096;
const TO_SRGB = Uint8ClampedArray.from({ length: SRGB_STEPS + 1 }, (_, i) =>
  Math.round(Math.pow(i / SRGB_STEPS, 1 / 2.2) * 255),
);

/**
 * The image tool keys transparency out of a solid color and leaves alpha
 * noisy: interiors near 250, stray texels of 1 carrying the key color. Snap
 * both ends so nothing is faintly see-through or faintly tinted.
 */
export function cleanAlpha(albedo: Pixels): void {
  const data = albedo.data;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i] ?? 0;
    if (a < 8) data[i] = 0;
    else if (a >= 240) data[i] = 255;
  }
}

export interface MapCorrections {
  /**
   * The map's X axis points left. A recorded correction for a generated
   * map, not an edit of intent (the Codex hill map, ADR 0018).
   */
  flipX?: boolean;
}

/**
 * Prepares a layer from its decoded maps, which must share the albedo's
 * size. The silhouette comes from the albedo, so a misaligned map shows as
 * such; normals are renormalized once here so lighting needs no square root.
 */
export function prepareLayer(
  albedo: Pixels,
  normalMap: Pixels,
  translucencyMap: Pixels | null,
  corrections: MapCorrections = {},
): LayerSource {
  const { width, height } = albedo;
  for (const map of [normalMap, translucencyMap])
    if (map !== null && (map.width !== width || map.height !== height))
      throw new Error(
        `map is ${String(map.width)}×${String(map.height)}, albedo ${String(width)}×${String(height)}`,
      );
  cleanAlpha(albedo);
  const a = albedo.data;
  const src = normalMap.data;
  const normals = new Uint8ClampedArray(a.length);
  const translucency =
    translucencyMap === null ? null : new Uint8Array(width * height);
  for (let i = 0, t = 0; i < a.length; i += 4, t++) {
    const inside = (a[i + 3] ?? 0) > 0;
    let x = 0;
    let y = 0;
    let z = 1;
    if (inside) {
      x = TO_UNIT[src[i] ?? 128] ?? 0;
      y = TO_UNIT[src[i + 1] ?? 128] ?? 0;
      z = TO_UNIT[src[i + 2] ?? 255] ?? 1;
      if (corrections.flipX === true) x = -x;
      const length = Math.hypot(x, y, z) || 1;
      x /= length;
      y /= length;
      z /= length;
    }
    normals[i] = x * 127.5 + 127.5;
    normals[i + 1] = y * 127.5 + 127.5;
    normals[i + 2] = z * 127.5 + 127.5;
    normals[i + 3] = a[i + 3] ?? 0;
    if (translucency !== null && inside && translucencyMap !== null) {
      // Gray maps: take the luminance.
      const d = translucencyMap.data;
      translucency[t] =
        0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    }
  }
  return {
    albedo,
    normals: { width, height, data: normals },
    translucency,
  };
}

/**
 * The layer mirrored left to right within each of `columns` equal cells, so
 * a sprite drawn mirrored is lit from the right side: normals' x is negated
 * rather than carrying the mirror image's reversed light.
 */
export function mirrorCells(source: LayerSource, columns: number): LayerSource {
  const { width, height } = source.albedo;
  const cell = width / columns;
  if (!Number.isInteger(cell))
    throw new Error(`width ${String(width)} is not ${String(columns)} cells`);
  const albedo = new Uint8ClampedArray(source.albedo.data.length);
  const normals = new Uint8ClampedArray(source.normals.data.length);
  const translucency =
    source.translucency === null ? null : new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const start = Math.floor(x / cell) * cell;
      const from = y * width + (start + cell - 1 - (x - start));
      const to = y * width + x;
      for (let c = 0; c < 4; c++) {
        albedo[to * 4 + c] = source.albedo.data[from * 4 + c] ?? 0;
        normals[to * 4 + c] = source.normals.data[from * 4 + c] ?? 0;
      }
      normals[to * 4] = 255 - (source.normals.data[from * 4] ?? 128);
      if (translucency !== null)
        translucency[to] = source.translucency?.[from] ?? 0;
    }
  return {
    albedo: { width, height, data: albedo },
    normals: { width, height, data: normals },
    translucency,
  };
}

/** Lights every texel; returns RGBA with the albedo's alpha. */
export function relight(
  source: LayerSource,
  p: LightParams,
  light: LayerLight,
): Uint8ClampedArray<ArrayBuffer> {
  const a = source.albedo.data;
  const nm = source.normals.data;
  const map = source.translucency;
  const out = new Uint8ClampedArray(a.length);
  const albedo: [number, number, number] = [0, 0, 0];
  const n: Vector3 = { x: 0, y: 0, z: 1 };
  const lit: [number, number, number] = [0, 0, 0];
  for (let i = 0, t = 0; i < a.length; i += 4, t++) {
    const alpha = a[i + 3] ?? 0;
    if (alpha === 0) continue;
    albedo[0] = TO_LINEAR[a[i] ?? 0] ?? 0;
    albedo[1] = TO_LINEAR[a[i + 1] ?? 0] ?? 0;
    albedo[2] = TO_LINEAR[a[i + 2] ?? 0] ?? 0;
    n.x = TO_UNIT[nm[i] ?? 128] ?? 0;
    n.y = TO_UNIT[nm[i + 1] ?? 128] ?? 0;
    n.z = TO_UNIT[nm[i + 2] ?? 255] ?? 1;
    shade(
      albedo,
      n,
      p,
      light,
      lit,
      map === null ? undefined : TO_FRACTION[map[t] ?? 0],
    );
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, lit[c] ?? 0));
      out[i + c] = TO_SRGB[Math.round(v * SRGB_STEPS)] ?? 0;
    }
    out[i + 3] = alpha;
  }
  return out;
}
