import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  COLUMN_LIMIT,
  crestAt,
  HILLSIDE_CAPACITY,
  hillsideLayout,
  type HillsideSlot,
} from "../../src/ui/hillside.ts";

/** Minimal decoder for the hill layer: 8-bit RGBA, non-interlaced PNG. */
function decodePng(file: string) {
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect([buf[24], buf[25], buf[28]]).toEqual([8, 6, 0]);
  const chunks: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(buf.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (px[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c = i >= 4 && y > 0 ? (px[(y - 1) * stride + i - 4] ?? 0) : 0;
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
  return { width, height, px };
}

// The relit scene's hill layer (ADR 0018): transparent above the grass.
const image = decodePng("src/ui/assets/scene/hill-albedo.png");

/** Solid grass: an opaque texel of the hill layer, green well above blue. */
function isGrass(xPercent: number, yPercent: number): boolean {
  const x = Math.round((xPercent / 100) * (image.width - 1));
  const y = Math.round((yPercent / 100) * (image.height - 1));
  const i = (y * image.width + x) * 4;
  const [r, g, b, a] = [
    image.px[i] ?? 0,
    image.px[i + 1] ?? 0,
    image.px[i + 2] ?? 0,
    image.px[i + 3] ?? 0,
  ];
  return a >= 240 && g - b > 25 && r > b && g > 50;
}

const COUNTS = Array.from({ length: HILLSIDE_CAPACITY }, (_, i) => i + 1);

/** The smallest separation of two 44 px icons, as max(|dx|, |dy|), in px. */
function minIconSeparation(
  slots: readonly HillsideSlot[],
  width: number,
  height: number,
): number {
  let min = Infinity;
  for (const [i, a] of slots.entries())
    for (const b of slots.slice(i + 1)) {
      const dx = (Math.abs(a.iconX - b.iconX) * width) / 100;
      const dy = (Math.abs(a.iconY - b.iconY) * height) / 100;
      min = Math.min(min, Math.max(dx, dy));
    }
  return min;
}

/**
 * Grass under and around a point: most texels within half a percent are
 * grass. The painted hill has small pale and dark specks that a single texel
 * can land on; a plant stands on the patch, not the speck.
 */
function onGrass(xPercent: number, yPercent: number): boolean {
  let grass = 0;
  let total = 0;
  for (let dx = -0.5; dx <= 0.5; dx += 0.25)
    for (let dy = -0.5; dy <= 0.5; dy += 0.25) {
      total++;
      if (isGrass(xPercent + dx, yPercent + dy)) grass++;
    }
  return grass / total >= 0.8;
}

describe("hillsideLayout", () => {
  it("places every repository up to the capacity, and is the same every time", () => {
    expect(hillsideLayout(0)).toEqual([]);
    expect(hillsideLayout(80)).toHaveLength(HILLSIDE_CAPACITY);
    for (const n of COUNTS) {
      expect(hillsideLayout(n), `n=${String(n)}`).toHaveLength(n);
      expect(hillsideLayout(n)).toEqual(hillsideLayout(n));
    }
  });

  it("the classifier separates sky, ridges, and grass on the hill layer", () => {
    expect(isGrass(50, 20)).toBe(false); // sky
    expect(isGrass(85, 62)).toBe(false); // ridges, behind the hill
    expect(isGrass(50, 85)).toBe(true);
  });

  it("every bush grows from the grass, with grass above its base too", () => {
    // At 16:9 (the worst case for `cover`, center-bottom), scene and image
    // percentages coincide. The base and the 10 px (about 1 %) above it are
    // grass, so no plant sits on the crest line or in the forest.
    for (const n of COUNTS)
      for (const [i, s] of hillsideLayout(n).entries()) {
        const where = `n=${String(n)} plant ${String(i)}`;
        expect(onGrass(s.x, s.y), `${where} base`).toBe(true);
        expect(onGrass(s.x, s.y - 1), `${where} above base`).toBe(true);
        expect(s.y, where).toBeLessThan(98);
      }
  });

  it("nearer plants are lower on the hill and larger", () => {
    for (const n of COUNTS) {
      // Depth is how far down the visible hill a base is, from its crest.
      const down = (s: HillsideSlot) =>
        (s.y - crestAt(s.x)) / (97.5 - crestAt(s.x));
      const slots = [...hillsideLayout(n)].sort((a, b) => down(a) - down(b));
      for (const [i, s] of slots.slice(1).entries())
        expect(s.scale, `n=${String(n)}`).toBeGreaterThanOrEqual(
          slots[i]?.scale ?? Infinity,
        );
    }
  });

  it("no two 44 px focus icons overlap at 1920x1080 or larger, for any count", () => {
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [2560, 1080],
    ] as const)
      for (const n of COUNTS)
        expect(
          minIconSeparation(hillsideLayout(n), width, height),
          `n=${String(n)} at ${String(width)}x${String(height)}`,
        ).toBeGreaterThanOrEqual(44);
  });

  it("gives each plant its own column while the icons fit, left to right", () => {
    for (let n = 2; n <= COLUMN_LIMIT; n++) {
      const xs = hillsideLayout(n).map((s) => s.x);
      for (const [i, x] of xs.slice(1).entries())
        expect(x, `n=${String(n)}`).toBeGreaterThan((xs[i] ?? 0) + 2.29);
    }
  });

  it("small gardens never stand one plant in front of another", () => {
    // A front plant is about 7.3 % of the width. Up to 12 plants, each
    // stands clear of every other whatever their depths; up to the column
    // limit, plants that are not clear are in different depth bands.
    for (let n = 2; n <= COLUMN_LIMIT; n++) {
      const slots = hillsideLayout(n);
      for (const [i, a] of slots.entries())
        for (const b of slots.slice(i + 1)) {
          const clear =
            Math.abs(a.x - b.x) >= 7.3 * Math.max(a.scale, b.scale) * 0.85;
          const where = `n=${String(n)}: ${JSON.stringify(a)} ${JSON.stringify(b)}`;
          if (n <= 12) expect(clear, where).toBe(true);
          else if (!clear)
            expect(Math.abs(a.y - b.y), where).toBeGreaterThan(2);
        }
    }
  });

  it("spreads every garden across the hill, centered", () => {
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    for (const n of COUNTS.slice(1)) {
      const xs = hillsideLayout(n).map((s) => s.x);
      expect(Math.abs(mean(xs) - 50), `n=${String(n)}`).toBeLessThan(8);
      expect(
        Math.max(...xs) - Math.min(...xs),
        `n=${String(n)}`,
      ).toBeGreaterThan(Math.min(35, 84 - 84 / n));
    }
    // One plant stands near the middle.
    expect(Math.abs((hillsideLayout(1)[0]?.x ?? 0) - 50)).toBeLessThan(3);
  });

  it("is not a grid: spacing and depth vary", () => {
    for (const n of [5, 8, 12, 20, 40, 64]) {
      const slots = hillsideLayout(n);
      const xs = slots.map((s) => s.x).sort((a, b) => a - b);
      const gaps = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
      expect(
        Math.max(...gaps) - Math.min(...gaps),
        `n=${String(n)}`,
      ).toBeGreaterThan(0.5);
      expect(
        new Set(slots.map((s) => s.y)).size,
        `n=${String(n)}`,
      ).toBeGreaterThan(n * 0.9);
    }
  });
});
