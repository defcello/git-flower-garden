/**
 * Loading the spike's art, and the deterministic "derived" normal maps that
 * are compared with Codex-generated ones (ADR 0018 "Art pipeline"): a rounded
 * shape from the silhouette plus fine detail from luminance. No model.
 */
import { deriveNormals, type DeriveOptions, type Pixels } from "./derive.ts";

export { deriveNormals, type DeriveOptions, type Pixels } from "./derive.ts";

export interface LayerArt {
  albedo: Pixels;
  normals: { derived: Pixels; codex: Pixels | null };
  /** Codex translucency map: red = how much light passes through, 0..1. */
  translucency: Pixels | null;
}

export type NormalSource = "derived" | "codex";

async function load(
  url: string,
  width?: number,
  height?: number,
): Promise<Pixels> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const w = width ?? bitmap.width;
  const h = height ?? bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, w, h);
  return { width: w, height: h, data: context.getImageData(0, 0, w, h).data };
}

/**
 * The image tool keys transparency out of a solid color and leaves alpha
 * noisy: interiors near 250, stray texels of 1 carrying the key color. Snap
 * both ends so nothing is faintly see-through or faintly tinted.
 */
function cleanAlpha(p: Pixels): Pixels {
  const data = p.data;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i] ?? 0;
    if (a < 8) data[i] = 0;
    else if (a >= 240) data[i] = 255;
  }
  return p;
}

/** Takes the silhouette from the albedo, so a misaligned map shows as such. */
function withAlbedoAlpha(normals: Pixels, albedo: Pixels): Pixels {
  const data = new Uint8ClampedArray(normals.data);
  for (let i = 3; i < data.length; i += 4) {
    const a = albedo.data[i] ?? 0;
    data[i] = a;
    // Outside the silhouette (a baked checkerboard, say), face the viewer
    // so filtering at the edge does not pick up nonsense normals.
    if (a === 0) {
      data[i - 3] = 128;
      data[i - 2] = 128;
      data[i - 1] = 255;
    }
  }
  return { ...normals, data };
}

export interface CodexNormals {
  url: string;
  /** The map's X axis points left; a recorded correction, not an edit of intent. */
  flipX?: boolean;
}

function flipX(p: Pixels): Pixels {
  for (let i = 0; i < p.data.length; i += 4)
    p.data[i] = 255 - (p.data[i] ?? 128);
  return p;
}

export async function loadLayer(
  albedoUrl: string,
  codexNormals: CodexNormals | null,
  derive: DeriveOptions,
  translucencyUrl: string | null = null,
): Promise<LayerArt> {
  const albedo = cleanAlpha(await load(albedoUrl));
  let translucency: Pixels | null = null;
  if (translucencyUrl !== null) {
    translucency = await load(translucencyUrl, albedo.width, albedo.height);
    // Gray: take the luminance, and nothing outside the albedo's silhouette.
    const d = translucency.data;
    for (let i = 0; i < d.length; i += 4) {
      const inside = (albedo.data[i + 3] ?? 0) > 0;
      const v = inside
        ? 0.299 * (d[i] ?? 0) +
          0.587 * (d[i + 1] ?? 0) +
          0.114 * (d[i + 2] ?? 0)
        : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  let codex: Pixels | null = null;
  if (codexNormals !== null) {
    const map = await load(codexNormals.url, albedo.width, albedo.height);
    codex = withAlbedoAlpha(
      codexNormals.flipX === true ? flipX(map) : map,
      albedo,
    );
  }
  return {
    albedo,
    normals: { derived: deriveNormals(albedo, derive), codex },
    translucency,
  };
}

export function decodeNormal(
  data: Uint8ClampedArray,
  i: number,
  out: { x: number; y: number; z: number },
) {
  const x = (data[i] ?? 128) / 127.5 - 1;
  const y = (data[i + 1] ?? 128) / 127.5 - 1;
  const z = (data[i + 2] ?? 255) / 127.5 - 1;
  const length = Math.hypot(x, y, z) || 1;
  out.x = x / length;
  out.y = y / length;
  out.z = z / length;
}
