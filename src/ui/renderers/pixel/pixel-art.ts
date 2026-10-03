/**
 * The pixel-art renderer's drawing (ADR 0022), kept pure: view models in, an
 * RGBA frame out, with no DOM. PixelRenderer.tsx only blits it to a canvas
 * and turns pointer positions into commits. It is deliberately small, as a
 * template for new renderers: everything it shows comes from `GardenView`
 * and `SceneEnvironment`.
 */
import type { GraphJson, GraphNodeJson } from "../../../api/types.ts";
import type { Color } from "../../../environment/lighting.ts";
import type { SceneEnvironment } from "../../viewmodel/environment.ts";
import type { GardenView, RepositoryView } from "../../viewmodel/garden.ts";

/** The frame's size in art pixels: 16:9, scaled up without smoothing. */
export const FRAME = { width: 128, height: 72 } as const;
/** Where the sky meets the land. */
const HORIZON = 38;

type Rgb = readonly [number, number, number];

/** A commit drawn as a pixel, for hit testing. */
export interface PixelNode {
  node: GraphNodeJson;
  x: number;
  y: number;
}

export interface PixelPlant {
  repo: RepositoryView;
  /** Bounds in art pixels, inclusive, for the plant's focus target. */
  box: { x0: number; y0: number; x1: number; y1: number };
  nodes: PixelNode[];
}

export interface PixelFrame {
  width: number;
  height: number;
  /** RGBA, row-major, as `ImageData` takes it. */
  pixels: Uint8ClampedArray;
  plants: PixelPlant[];
}

/** The light a garden without an environment is drawn in. */
export interface PixelLight {
  zenith: Color;
  horizon: Color;
  /** 0..1: how brightly the land is lit. */
  daylight: number;
  stars: number;
  sun: { u: number; altitude: number; visible: boolean; color: Color } | null;
  moon: { u: number; altitude: number; visible: boolean; color: Color } | null;
}

const NOON: PixelLight = {
  zenith: [0.25, 0.48, 0.85],
  horizon: [0.7, 0.82, 0.93],
  daylight: 1,
  stars: 0,
  sun: null,
  moon: null,
};

/** 4×4 ordered-dither thresholds, for banded pixel-art gradients. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** A stable small hash, so seeded details hold still between frames. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const to255 = (c: Color): Rgb => [c[0] * 255, c[1] * 255, c[2] * 255];

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function grey(c: Rgb, amount: number): Rgb {
  const g = (c[0] + c[1] + c[2]) / 3;
  return mix(c, [g, g, g], amount);
}

function pixelLight(environment: SceneEnvironment | null): PixelLight {
  if (!environment) return NOON;
  const { light } = environment;
  const body = (b: typeof light.sun) => ({
    u: b.u,
    altitude: b.altitude,
    // Bodies behind the viewer are folded onto the panorama, as the garden does.
    visible: b.aboveHorizon,
    color: b.color,
  });
  const ambient = (light.ambient[0] + light.ambient[1] + light.ambient[2]) / 3;
  return {
    zenith: light.sky.zenith,
    horizon: light.sky.horizon,
    daylight: clamp(0.35 + ambient * 0.6 + light.sun.intensity * 0.6, 0.35, 1),
    stars: light.stars,
    sun: body(light.sun),
    moon: body(light.moon),
  };
}

class Canvas {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  set(x: number, y: number, c: Rgb, alpha = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const p = this.pixels;
    p[i] = (p[i] ?? 0) + (c[0] - (p[i] ?? 0)) * alpha;
    p[i + 1] = (p[i + 1] ?? 0) + (c[1] - (p[i + 1] ?? 0)) * alpha;
    p[i + 2] = (p[i + 2] ?? 0) + (c[2] - (p[i + 2] ?? 0)) * alpha;
    p[i + 3] = 255;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /** Bresenham's line; `dash` skips every other pixel. */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, dash = false) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; ; n++) {
      if (!dash || n % 2 === 0) this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: Rgb): void {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r) this.set(cx + x, cy + y, c);
  }
}

/** Banded, dithered sky from the zenith down to the horizon. */
function drawSky(canvas: Canvas, light: PixelLight): void {
  const top = to255(light.zenith);
  const bottom = to255(light.horizon);
  const step = 16;
  for (let y = 0; y < HORIZON; y++) {
    const c = mix(top, bottom, y / (HORIZON - 1));
    for (let x = 0; x < canvas.width; x++) {
      const t = ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) / 16 - 0.5) * step;
      canvas.set(x, y, [
        Math.round((c[0] + t) / step) * step,
        Math.round((c[1] + t) / step) * step,
        Math.round((c[2] + t) / step) * step,
      ]);
    }
  }
  if (light.stars > 0.05) {
    const random = seeded(7);
    const count = Math.round(40 * light.stars);
    for (let i = 0; i < count; i++) {
      const x = random() * canvas.width;
      const y = random() * (HORIZON - 6);
      canvas.set(x, y, [255, 255, 235], light.stars);
    }
  }
  const skyY = (altitude: number) =>
    HORIZON - 3 - (clamp(altitude, 0, 90) / 90) * (HORIZON - 8);
  const moon = light.moon;
  if (moon?.visible)
    canvas.disc(
      moon.u * canvas.width,
      skyY(moon.altitude),
      3,
      to255(moon.color),
    );
  const sun = light.sun;
  if (sun?.visible) {
    const c = mix(to255(sun.color), [255, 250, 210], 0.5);
    canvas.disc(sun.u * canvas.width, skyY(sun.altitude), 4, c);
  }
}

/** A far ridge and the near hillside, lit by the day. */
function drawLand(canvas: Canvas, light: PixelLight): void {
  const ridge = scale([70, 96, 120], light.daylight);
  const near = scale([74, 128, 58], light.daylight);
  const far = scale([58, 104, 52], light.daylight);
  for (let x = 0; x < canvas.width; x++) {
    const h = Math.round(
      4 + 3 * Math.sin(x / 11) + 2 * Math.sin(x / 5 + 1.3) + Math.sin(x / 2.1),
    );
    for (let y = HORIZON - h; y < HORIZON; y++) canvas.set(x, y, ridge);
    for (let y = HORIZON; y < canvas.height; y++) {
      const band = (y - HORIZON) / (canvas.height - HORIZON);
      const dither = (BAYER[(y % 4) * 4 + (x % 4)] ?? 0) / 16;
      canvas.set(x, y, band + dither * 0.3 < 0.35 ? far : near);
    }
  }
}

const STEM: Rgb = [46, 110, 40];
const LEAF: Rgb = [110, 180, 70];
const ANCESTOR: Rgb = [40, 80, 34];
const FRUIT: Rgb = [214, 48, 40];
const CENTER: Rgb = [250, 220, 70];
const PETALS: Rgb[] = [
  [236, 96, 160],
  [250, 250, 250],
  [150, 110, 230],
  [250, 150, 60],
  [90, 170, 240],
];
const SOIL: Rgb = [110, 74, 44];
const STAKE: Rgb = [196, 160, 110];

/** Places a graph's commits on the art grid above `baseY`, newest highest. */
function placeNodes(graph: GraphJson, cx: number, baseY: number): PixelNode[] {
  const rows = Math.max(1, graph.size.rows);
  const lanes = Math.max(1, graph.size.lanes);
  const stepY = clamp(Math.floor((baseY - 10) / rows), 1, 3);
  const stepX = clamp(Math.floor(12 / lanes), 1, 3);
  return graph.nodes.map((node) => ({
    node,
    x: Math.round(cx + (node.lane - (lanes - 1) / 2) * stepX),
    y: Math.round(baseY - 3 - node.row * stepY),
  }));
}

function drawPlant(
  canvas: Canvas,
  repo: RepositoryView,
  cx: number,
  baseY: number,
  light: PixelLight,
): PixelPlant {
  const tone = (c: Rgb) =>
    scale(repo.health.wilting ? grey(c, 0.65) : c, light.daylight);
  const box = { x0: cx - 4, y0: baseY - 6, x1: cx + 4, y1: baseY + 1 };
  const graph = repo.graph;
  if (!graph || !repo.drawable) {
    // No commits, or nothing readable yet: a bare soil bed.
    canvas.rect(cx - 4, baseY, 9, 2, tone(SOIL));
    if (repo.health.marker !== null) {
      canvas.line(cx + 5, baseY, cx + 5, baseY - 6, tone(STAKE));
      canvas.rect(cx + 4, baseY - 7, 3, 2, tone(STAKE));
    }
    return { repo, box, nodes: [] };
  }
  const nodes = placeNodes(graph, cx, baseY);
  const at = new Map(nodes.map((n) => [n.node.oid, n]));
  // Stems: parent links, dashed where history is hidden.
  for (const edge of graph.edges) {
    const a = at.get(edge.child);
    const b = at.get(edge.parent);
    if (a && b)
      canvas.line(a.x, a.y, b.x, b.y, tone(STEM), edge.kind === "collapsed");
  }
  for (const tail of graph.tails) {
    const a = at.get(tail.child);
    if (a) canvas.line(a.x, a.y, a.x, baseY, tone(STEM), true);
  }
  const lowest = nodes.reduce((y, n) => Math.max(y, n.y), 0);
  canvas.line(cx, lowest, cx, baseY, tone(STEM));
  canvas.rect(cx - 2, baseY, 5, 1, tone(SOIL));
  const petals = PETALS[hash(repo.id) % PETALS.length] ?? PETALS[0];
  for (const { node, x, y } of nodes) {
    const reasons = new Set(node.reasons);
    if (reasons.has("head")) {
      const p = tone(petals ?? [250, 250, 250]);
      canvas.set(x - 1, y, p);
      canvas.set(x + 1, y, p);
      canvas.set(x, y - 1, p);
      canvas.set(x, y + 1, p);
      canvas.set(x, y, tone(CENTER));
    } else if (reasons.has("ancestor")) {
      canvas.set(x, y, tone(ANCESTOR));
    } else {
      canvas.set(x + (node.row % 2 === 0 ? 1 : -1), y, tone(LEAF));
      canvas.set(x, y, tone(STEM));
    }
    if (node.refs.some((ref) => ref.startsWith("tag: ")))
      canvas.set(x + 1, y + 1, tone(FRUIT));
    box.x0 = Math.min(box.x0, x - 2);
    box.x1 = Math.max(box.x1, x + 2);
    box.y0 = Math.min(box.y0, y - 2);
  }
  if (repo.health.marker !== null) {
    canvas.line(box.x1 + 1, baseY, box.x1 + 1, baseY - 6, tone(STAKE));
    canvas.rect(box.x1, baseY - 7, 3, 2, tone(STAKE));
  }
  return { repo, box, nodes };
}

function drawWeather(
  canvas: Canvas,
  environment: SceneEnvironment | null,
): void {
  const weather = environment?.weather;
  if (!weather) return;
  const { effects, minutes } = weather;
  const fall = effects.precipitation;
  if (fall) {
    const random = seeded(hash(String(minutes)));
    const count = Math.round(120 * fall.density);
    const slant = clamp(effects.windX / 6, -2, 2);
    const snow = fall.type === "snow";
    const color: Rgb = snow ? [245, 248, 255] : [170, 190, 215];
    for (let i = 0; i < count; i++) {
      const x = random() * canvas.width;
      const y = random() * canvas.height;
      if (snow) canvas.set(x, y, color, 0.9);
      else canvas.line(x, y, x + slant, y + 2, color);
    }
  }
  if (effects.fog > 0) {
    const fog: Rgb = [200, 205, 210];
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        canvas.set(x, y, fog, clamp(effects.fog * 0.6, 0, 0.8));
  }
}

/**
 * One frame of the pixel garden. Plants stand in two staggered rows across
 * the hillside, in configuration order; a branch head is a flower, a commit
 * a leaf, a tag a red fruit, a common ancestor a dark knot. Wilting plants
 * are greyed, and an unhealthy repository carries a stake.
 */
export function pixelFrame(
  garden: GardenView,
  environment: SceneEnvironment | null,
): PixelFrame {
  const canvas = new Canvas(FRAME.width, FRAME.height);
  const light = pixelLight(environment);
  drawSky(canvas, light);
  drawLand(canvas, light);
  const repos = garden.repositories;
  const plants: PixelPlant[] = [];
  const count = repos.length;
  // Back row first, so nearer plants draw over farther ones.
  const order = repos
    .map((repo, i) => ({ repo, i, back: count > 4 && i % 2 === 1 }))
    .sort((a, b) => Number(b.back) - Number(a.back));
  for (const { repo, i, back } of order) {
    const cx = Math.round(((i + 0.5) / Math.max(1, count)) * FRAME.width);
    const baseY = back ? HORIZON + 17 : HORIZON + 28;
    plants.push(drawPlant(canvas, repo, cx, baseY, light));
  }
  drawWeather(canvas, environment);
  plants.sort((a, b) => a.repo.index - b.repo.index);
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: canvas.pixels,
    plants,
  };
}

/** The commit at an art-pixel position (within two pixels), nearest first. */
export function nodeAt(
  frame: PixelFrame,
  x: number,
  y: number,
): { plant: PixelPlant; node: GraphNodeJson } | null {
  let best: { plant: PixelPlant; node: GraphNodeJson } | null = null;
  let bestDistance = 2.5 * 2.5;
  for (const plant of frame.plants)
    for (const n of plant.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d <= bestDistance) {
        bestDistance = d;
        best = { plant, node: n.node };
      }
    }
  return best;
}

/** The commit a plant opens on: its newest branch head, else its newest commit. */
export function featuredCommit(plant: PixelPlant): GraphNodeJson | null {
  const newest = [...plant.nodes].sort((a, b) => b.node.row - a.node.row);
  return (
    newest.find((n) => n.node.reasons.includes("head"))?.node ??
    newest[0]?.node ??
    null
  );
}
