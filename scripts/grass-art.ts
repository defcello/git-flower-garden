/*
 * Makes the grass art from its sources (ADR 0021): the Codex-painted tuft
 * atlas and ground, and the hill they replace. Deterministic, no model, so
 * every derived map lines up with its albedo by construction (Codex's own
 * normal and translucency maps for the tufts did not; docs/art/prompts.md).
 *
 *   node scripts/grass-art.ts            # writes src/ui/assets/scene/
 *
 * - grass-albedo.png: the Codex tuft atlas, unchanged.
 * - grass-normal.png: each blade a rounded strip from its silhouette, with
 *   fine detail from luminance (`deriveNormals`, as in the relight spike).
 * - grass-translucency.png: thin blades pass light, most at their tips.
 * - hill-albedo.png: the Codex ground, graded darker toward the shade at
 *   the tufts' feet, under the old hill's crest, made
 *   clean: opaque below a smoothed crest line, with a one-pixel soft edge
 *   and none of the old layer's stray blade tips above it.
 * - hill-normal.png: the old hill's dome (its Codex map, X corrected and
 *   blurred until its blade streaks are gone) with the ground's fine detail.
 * - hill-translucency.png: short turf passes little light.
 * - src/ui/scene/crest.ts: that crest, in design pixels, for planting the
 *   tufts (scene/grass.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { format } from "prettier";
import { deriveNormals, type Pixels } from "../spikes/relight/derive.ts";

const SOURCES = "docs/art/grass";
const OLD_HILL = "spikes/relight/art";
const OUT = "src/ui/assets/scene";

/** 8-bit RGB or RGBA, non-interlaced PNG, as RGBA. */
function decode(file: string): Pixels {
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [depth, color, interlace] = [buf[24], buf[25], buf[28]];
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
    throw new Error(`${file}: unsupported PNG (${String([depth, color])})`);
  const channels = color === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    if (buf.toString("ascii", at + 4, at + 8) === "IDAT")
      chunks.push(buf.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (px[y * stride + i - channels] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c =
        i >= channels && y > 0 ? (px[(y - 1) * stride + i - channels] ?? 0) : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const e = a + b - c;
        const [pa, pb, pc] = [
          Math.abs(e - a),
          Math.abs(e - b),
          Math.abs(e - c),
        ];
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + i] = (v + p) & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = px[i * channels] ?? 0;
    data[i * 4 + 1] = px[i * channels + 1] ?? 0;
    data[i * 4 + 2] = px[i * channels + 2] ?? 0;
    data[i * 4 + 3] = channels === 4 ? (px[i * channels + 3] ?? 0) : 255;
  }
  return { width, height, data };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}

/** RGBA (or RGB when `alpha` is false) PNG, unfiltered rows. */
function encode(p: Pixels, alpha: boolean): Buffer {
  const channels = alpha ? 4 : 3;
  const stride = p.width * channels + 1;
  const raw = Buffer.alloc(stride * p.height);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      for (let c = 0; c < channels; c++)
        raw[y * stride + 1 + x * channels + c] =
          p.data[(y * p.width + x) * 4 + c] ?? 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(p.width, 0);
  header.writeUInt32BE(p.height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const luminance = (d: Uint8ClampedArray, i: number) =>
  (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) /
  255;

/** Euclidean-ish distance to transparency, by chamfer passes (3-4 metric). */
function edgeDistance(p: Pixels): Float32Array {
  const { width: w, height: h, data } = p;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++)
    d[i] = (data[i * 4 + 3] ?? 0) < 128 ? 0 : 1e9;
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : (d[y * w + x] ?? 0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      d[i] = Math.min(
        d[i] ?? 0,
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      d[i] = Math.min(
        d[i] ?? 0,
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  for (let i = 0; i < d.length; i++) d[i] = (d[i] ?? 0) / 3;
  return d;
}

/** Box blur of one channel set, `passes` times (close to Gaussian). */
function blurRgb(p: Pixels, radius: number, passes: number): Pixels {
  const { width: w, height: h } = p;
  let src = Float32Array.from(p.data);
  let dst = new Float32Array(src.length);
  for (let pass = 0; pass < passes * 2; pass++) {
    const horizontal = pass % 2 === 0;
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    for (let line = 0; line < lines; line++)
      for (let c = 0; c < 3; c++) {
        const idx = (i: number) => {
          const k = Math.min(len - 1, Math.max(0, i));
          return (horizontal ? line * w + k : k * w + line) * 4 + c;
        };
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += src[idx(i)] ?? 0;
        for (let i = 0; i < len; i++) {
          dst[idx(i)] = sum / (2 * radius + 1);
          sum += (src[idx(i + radius + 1)] ?? 0) - (src[idx(i - radius)] ?? 0);
        }
      }
    [src, dst] = [dst, src];
  }
  const data = new Uint8ClampedArray(p.data);
  for (let i = 0; i < data.length; i += 4)
    for (let c = 0; c < 3; c++) data[i + c] = src[i + c] ?? 0;
  return { width: w, height: h, data };
}

// The tufts.
const tufts = decode(`${SOURCES}/grass-albedo-codex.png`);
writeFileSync(
  `${OUT}/grass-albedo.png`,
  readFileSync(`${SOURCES}/grass-albedo-codex.png`),
);
for (let i = 3; i < tufts.data.length; i += 4) {
  // As cleanAlpha (relight.ts) does at load: the keyed alpha is noisy.
  const a = tufts.data[i] ?? 0;
  tufts.data[i] = a < 8 ? 0 : a >= 240 ? 255 : a;
}
writeFileSync(
  `${OUT}/grass-normal.png`,
  // Strong relief: the tufts are drawn from 256-pixel cells (a 627-pixel
  // source), so a faint rim or faint luminance detail flattens to a card
  // there. Each painted blade, light along its middle and dark at its
  // overlaps, becomes its own ridge.
  encode(deriveNormals(tufts, { radius: 14, detail: 28 }), true),
);
const cell = tufts.width / 2;
const thin = edgeDistance(tufts);
const trans = new Uint8ClampedArray(tufts.data.length);
for (let y = 0; y < tufts.height; y++)
  for (let x = 0; x < tufts.width; x++) {
    const i = y * tufts.width + x;
    const a = (tufts.data[i * 4 + 3] ?? 0) / 255;
    // Height above the cell's bottom edge, where each tuft grows from.
    const up = 1 - (y % cell) / cell;
    const tip = Math.min(1, 0.2 + up * 1.1);
    const narrow = 1 - Math.min(1, Math.max(0, ((thin[i] ?? 0) - 1) / 8));
    // Paler painted blades are the thin, sunlit ones: they pass more.
    const pale = luminance(tufts.data, i * 4);
    const v = a * tip * (0.35 + 0.35 * narrow + 0.5 * pale) * 255;
    trans[i * 4] = trans[i * 4 + 1] = trans[i * 4 + 2] = v;
    trans[i * 4 + 3] = 255;
  }
writeFileSync(
  `${OUT}/grass-translucency.png`,
  encode({ width: tufts.width, height: tufts.height, data: trans }, false),
);

// The ground, under the old hill's crest.
const ground = decode(`${SOURCES}/ground-albedo-codex.png`);
const oldHill = decode(`${OLD_HILL}/hill-albedo.png`);
const { width: W, height: H } = ground;
if (oldHill.width !== W || oldHill.height !== H)
  throw new Error("the ground and the old hill differ in size");
// The crest: per column, the first of six opaque rows (stray blade tips
// above it are not the crest), smoothed across 9 columns.
const crest = new Float32Array(W);
for (let x = 0; x < W; x++) {
  let y = 0;
  const opaque = (yy: number) =>
    (oldHill.data[(yy * W + x) * 4 + 3] ?? 0) >= 240;
  for (; y < H - 6; y++) {
    let run = true;
    for (let k = 0; k < 6 && run; k++) run = opaque(y + k);
    if (run) break;
  }
  crest[x] = y;
}
const smooth = new Float32Array(W);
for (let x = 0; x < W; x++) {
  let sum = 0;
  let n = 0;
  for (let k = -4; k <= 4; k++) {
    const v = crest[Math.min(W - 1, Math.max(0, x + k))];
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  smooth[x] = sum / n;
}
// Graded toward the shade at the foot of the tufts (their lower parts
// average RGB 98, 125, 29; the Codex ground 127, 142, 46): between the
// tufts the ground reads as the shaded depth of the grass, not as a lawn
// behind it.
const GRADE = [0.55, 0.63, 0.48];
const albedo = new Uint8ClampedArray(ground.data);
for (let i = 0; i < albedo.length; i += 4)
  for (let c = 0; c < 3; c++)
    albedo[i + c] = (albedo[i + c] ?? 0) * (GRADE[c] ?? 1);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    albedo[(y * W + x) * 4 + 3] =
      Math.min(1, Math.max(0, y - (smooth[x] ?? 0) + 0.5)) * 255;
const groundOut: Pixels = { width: W, height: H, data: albedo };
// The crest in design pixels (the layer spans 1920×1080), every 20.
const crestDesign = Array.from({ length: 97 }, (_, i) => {
  const ax = Math.min(W - 1, Math.round(((i * 20) / 1920) * W));
  return Math.round(((smooth[ax] ?? 0) / H) * 1080 * 10) / 10;
});
writeFileSync(
  "src/ui/scene/crest.ts",
  await format(
    `/*
 * The hill's crest, in design pixels: its top edge every 20 pixels across
 * the 1920×1080 design space, from the ground layer's alpha. Generated by
 * scripts/grass-art.ts; do not edit.
 */
export const CREST_STEP = 20;
export const CREST: readonly number[] = [
${crestDesign.map((v) => String(v)).join(", ")},
];
`,
    { parser: "typescript" },
  ),
);
writeFileSync(`${OUT}/hill-albedo.png`, encode(groundOut, true));

// The dome: the old map's X axis pointed left (relight.ts, ADR 0018).
const oldNormal = decode(`${OLD_HILL}/hill-normal-codex.png`);
for (let i = 0; i < oldNormal.data.length; i += 4)
  oldNormal.data[i] = 255 - (oldNormal.data[i] ?? 128);
const dome = blurRgb(oldNormal, 12, 2);
const normal = new Uint8ClampedArray(albedo.length);
const lum = (x: number, y: number) =>
  luminance(
    ground.data,
    (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4,
  );
const DETAIL = 1.6;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if ((albedo[i + 3] ?? 0) === 0) {
      // Above the crest: facing the viewer, so filtering at the edge never
      // picks up the source's baked checkerboard.
      normal.set([128, 128, 255, 255], i);
      continue;
    }
    const nx = ((dome.data[i] ?? 128) - 127.5) / 127.5;
    const ny = ((dome.data[i + 1] ?? 128) - 127.5) / 127.5;
    const nz = Math.max(0.2, ((dome.data[i + 2] ?? 255) - 127.5) / 127.5);
    // Fine turf detail: luminance as height (image y runs down).
    const dx = (lum(x + 1, y) - lum(x - 1, y)) * DETAIL;
    const dy = (lum(x, y + 1) - lum(x, y - 1)) * DETAIL;
    const mx = nx / nz - dx;
    const my = ny / nz + dy;
    const length = Math.hypot(mx, my, 1);
    normal[i] = (mx / length) * 127.5 + 127.5;
    normal[i + 1] = (my / length) * 127.5 + 127.5;
    normal[i + 2] = (1 / length) * 127.5 + 127.5;
    normal[i + 3] = 255;
  }
writeFileSync(
  `${OUT}/hill-normal.png`,
  encode({ width: W, height: H, data: normal }, false),
);
const turf = new Uint8ClampedArray(albedo.length);
for (let i = 0; i < turf.length; i += 4) {
  const a = (albedo[i + 3] ?? 0) / 255;
  const v = a * (0.12 + 0.18 * luminance(ground.data, i)) * 255;
  turf[i] = turf[i + 1] = turf[i + 2] = v;
  turf[i + 3] = 255;
}
writeFileSync(
  `${OUT}/hill-translucency.png`,
  encode({ width: W, height: H, data: turf }, false),
);
console.log("grass art written to", OUT);
