/**
 * Loading the spike's art, and the deterministic "derived" normal maps that
 * are compared with Codex-generated ones (ADR 0018 "Art pipeline"): a rounded
 * shape from the silhouette plus fine detail from luminance. No model.
 */

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

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

export interface DeriveOptions {
  /** Radius of the rounded edge profile, in source pixels. */
  radius: number;
  /** Height of luminance detail, in source pixels. */
  detail: number;
}

/** One row or column of the exact squared-distance transform (Felzenszwalb). */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const intersect = (q: number, vk: number) =>
    ((f[q] ?? 0) + q * q - ((f[vk] ?? 0) + vk * vk)) / (2 * q - 2 * vk);
  for (let q = 1; q < n; q++) {
    // z[0] is -Infinity, so this stops at k = 0 at the latest.
    let s = intersect(q, v[k] ?? 0);
    while (s <= (z[k] ?? -Infinity)) {
      k--;
      s = intersect(q, v[k] ?? 0);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? Infinity) < q) k++;
    const vk = v[k] ?? 0;
    d[q] = (q - vk) * (q - vk) + (f[vk] ?? 0);
  }
}

/** Euclidean distance from each opaque texel to the nearest transparent one. */
function distanceToEdge(p: Pixels): Float32Array {
  const { width, height, data } = p;
  const far = 1e12;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++)
    grid[i] = (data[i * 4 + 3] ?? 0) < 128 ? 0 : far;
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x] ?? 0;
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y] ?? 0;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x] ?? 0;
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x] ?? 0;
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i] ?? 0);
  return out;
}

/** Separable box blur, applied twice: close to a Gaussian, cheap to run. */
function blur(
  values: Float32Array<ArrayBuffer>,
  width: number,
  height: number,
  radius: number,
): Float32Array<ArrayBuffer> {
  if (radius < 1) return values;
  let a = values;
  let b = new Float32Array(values.length);
  const pass = (
    from: Float32Array<ArrayBuffer>,
    to: Float32Array<ArrayBuffer>,
    horizontal: boolean,
  ) => {
    const lines = horizontal ? height : width;
    const length = horizontal ? width : height;
    const at = (line: number, i: number) =>
      horizontal ? line * width + i : i * width + line;
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++)
        sum += from[at(line, Math.min(length - 1, Math.max(0, i)))] ?? 0;
      for (let i = 0; i < length; i++) {
        to[at(line, i)] = sum / (2 * radius + 1);
        sum +=
          (from[at(line, Math.min(length - 1, i + radius + 1))] ?? 0) -
          (from[at(line, Math.max(0, i - radius))] ?? 0);
      }
    }
  };
  for (let round = 0; round < 2; round++) {
    pass(a, b, true);
    [a, b] = [b, a];
    pass(a, b, false);
    [a, b] = [b, a];
  }
  return a;
}

export function deriveNormals(p: Pixels, options: DeriveOptions): Pixels {
  const { width, height, data } = p;
  const distance = distanceToEdge(p);
  // Luminance, lightly blurred so painted grain does not become noise.
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++)
    lum[i] =
      (0.2126 * (data[i * 4] ?? 0) +
        0.7152 * (data[i * 4 + 1] ?? 0) +
        0.0722 * (data[i * 4 + 2] ?? 0)) /
      255;
  const blurred = new Float32Array(lum.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          sum += lum[yy * width + xx] ?? 0;
          count++;
        }
      blurred[y * width + x] = sum / count;
    }
  let profile = new Float32Array(lum.length);
  for (let i = 0; i < profile.length; i++) {
    const t = Math.min(1, (distance[i] ?? 0) / options.radius);
    profile[i] = options.radius * Math.sqrt(1 - (1 - t) * (1 - t));
  }
  // Soften the silhouette's jaggies (grass tips, tree crowns) so they read
  // as a rounded form rather than streaks down the layer.
  profile = blur(profile, width, height, Math.round(options.radius / 8));
  const height_ = new Float32Array(lum.length);
  for (let i = 0; i < height_.length; i++)
    height_[i] = (profile[i] ?? 0) + options.detail * (blurred[i] ?? 0);
  const out = new Uint8ClampedArray(data.length);
  const h = (x: number, y: number) =>
    height_[
      Math.min(height - 1, Math.max(0, y)) * width +
        Math.min(width - 1, Math.max(0, x))
    ] ?? 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) / 2;
      const dy = (h(x, y + 1) - h(x, y - 1)) / 2;
      // Image y runs down, scene y up: height rising downward faces up.
      const nx = -dx;
      const ny = dy;
      const length = Math.hypot(nx, ny, 1);
      const i = (y * width + x) * 4;
      out[i] = (nx / length) * 127.5 + 127.5;
      out[i + 1] = (ny / length) * 127.5 + 127.5;
      out[i + 2] = (1 / length) * 127.5 + 127.5;
      out[i + 3] = data[i + 3] ?? 0;
    }
  return { width, height, data: out };
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
