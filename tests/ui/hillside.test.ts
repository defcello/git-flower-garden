import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  HILLSIDE_COLUMNS,
  HILLSIDE_SLOTS,
  hillsideSlots,
} from "../../src/ui/hillside.ts";
import { generate } from "../../scripts/hillside-slots.ts";

/** Minimal decoder for the backdrop: 8-bit RGB, non-interlaced PNG. */
function decodePng(file: string) {
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect([buf[24], buf[25], buf[28]]).toEqual([8, 2, 0]);
  const chunks: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(buf.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 3;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 3 ? (px[y * stride + i - 3] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c = i >= 3 && y > 0 ? (px[(y - 1) * stride + i - 3] ?? 0) : 0;
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

const image = decodePng("src/ui/assets/blue-ridge-day.png");

/** Grass, lit or shaded: green well above blue, unlike sky, haze, and the blue-green forest. */
function isGrass(xPercent: number, yPercent: number): boolean {
  const x = Math.round((xPercent / 100) * (image.width - 1));
  const y = Math.round((yPercent / 100) * (image.height - 1));
  const i = (y * image.width + x) * 3;
  const [r, g, b] = [
    image.px[i] ?? 0,
    image.px[i + 1] ?? 0,
    image.px[i + 2] ?? 0,
  ];
  return g - b > 25 && r > b && g > 50;
}

describe("hillside slots", () => {
  it("has 64 slots, reproducible by the generator", () => {
    expect(HILLSIDE_SLOTS).toHaveLength(64);
    expect(generate()).toEqual(HILLSIDE_SLOTS);
  });

  it("the classifier separates sky, forest, and grass on the backdrop", () => {
    expect(isGrass(50, 20)).toBe(false); // sky
    expect(isGrass(80, 66)).toBe(false); // forest ridge
    expect(isGrass(50, 85)).toBe(true);
  });

  it("every bush grows from the grass, with grass above its base too", () => {
    // At 16:9 (the worst case for `cover`, center-bottom), scene and image
    // percentages coincide. The base and the 10 px (about 1 %) above it are
    // grass, so no plant sits on the crest line or in the forest.
    for (const [i, s] of HILLSIDE_SLOTS.entries()) {
      expect(isGrass(s.x, s.y), `slot ${String(i)} base`).toBe(true);
      expect(isGrass(s.x, s.y - 1), `slot ${String(i)} above base`).toBe(true);
      expect(s.y, `slot ${String(i)}`).toBeLessThan(98);
    }
  });

  it("rows recede: back rows are higher on the hill and smaller", () => {
    for (let r = 1; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const back = HILLSIDE_SLOTS[(r - 1) * 8 + c];
        const front = HILLSIDE_SLOTS[r * 8 + c];
        expect(front?.scale).toBeGreaterThan(back?.scale ?? Infinity);
        expect(front?.y).toBeGreaterThan(back?.y ?? Infinity);
      }
    }
  });

  it("no two 44 px focus icons overlap at 1920x1080 or larger", () => {
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [2560, 1080],
    ] as const) {
      for (let i = 0; i < 64; i++) {
        for (let j = i + 1; j < 64; j++) {
          const a = HILLSIDE_SLOTS[i],
            b = HILLSIDE_SLOTS[j];
          if (!a || !b) throw new Error("slot");
          const dx = (Math.abs(a.iconX - b.iconX) * width) / 100;
          const dy = (Math.abs(a.iconY - b.iconY) * height) / 100;
          expect(
            Math.max(dx, dy),
            `icons ${String(i)} and ${String(j)} at ${String(width)}x${String(height)}`,
          ).toBeGreaterThanOrEqual(44);
        }
      }
    }
  });
});

describe("hillsideSlots", () => {
  it("assigns distinct slots, in order back to front and left to right", () => {
    for (let n = 1; n <= 64; n++) {
      const slots = hillsideSlots(n);
      expect(slots, `n=${String(n)}`).toHaveLength(n);
      expect(new Set(slots).size).toBe(n);
      expect([...slots].sort((a, b) => a - b)).toEqual(slots);
    }
    expect(hillsideSlots(0)).toEqual([]);
    expect(hillsideSlots(80)).toHaveLength(64);
  });

  it("fills every slot at 64", () => {
    expect(hillsideSlots(64)).toEqual([...Array(64).keys()]);
  });

  it("spreads small gardens across the hill, not into one corner", () => {
    for (let n = 2; n <= 64; n++) {
      const slots = hillsideSlots(n);
      const rows = new Set(slots.map((s) => Math.floor(s / HILLSIDE_COLUMNS)));
      const xs = slots.map((s) => HILLSIDE_SLOTS[s]?.x ?? 0);
      const ys = slots.map((s) => HILLSIDE_SLOTS[s]?.y ?? 0);
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      // Centered on the hill, and using its width.
      expect(Math.abs(mean(xs) - 50), `n=${String(n)}`).toBeLessThan(8);
      expect(
        Math.max(...xs) - Math.min(...xs),
        `n=${String(n)}`,
      ).toBeGreaterThan(35);
      // Rows are evenly spaced: never all at the back or all at the front.
      if (rows.size > 1) {
        expect(Math.min(...ys), `n=${String(n)}`).toBeLessThan(86);
        expect(Math.max(...ys), `n=${String(n)}`).toBeGreaterThan(84);
      }
      // Row sizes differ by at most one.
      const counts = [...rows].map(
        (r) =>
          slots.filter((s) => Math.floor(s / HILLSIDE_COLUMNS) === r).length,
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });
});
