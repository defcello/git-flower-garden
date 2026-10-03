/*
 * Where the garden view's plants grow on the hillside (roadmap section 7,
 * ADR 0023). The layout is computed for the number of repositories:
 *
 * - X comes first. Every plant gets its own column, evenly spaced across the
 *   hill, as long as columns stay wide enough for the 44 px focus icons
 *   (up to COLUMN_LIMIT plants). Plants that share a depth band are a whole
 *   plant's width apart, so no plant stands in front of another unless the
 *   garden is too big to avoid it.
 * - Depth (Y) follows. A small garden is one band across the hill; a larger
 *   one alternates its columns between back and front bands.
 * - Beyond COLUMN_LIMIT, plants are laid out in staggered rows.
 *
 * Seeded jitter in X and depth keeps the planting from reading as a grid.
 * It is bounded so that no two focus icons overlap at 1920x1080 or larger,
 * and the layout for a given count is always the same. Checked by
 * tests/ui/hillside.test.ts against the relit hill art.
 */

export interface HillsideSlot {
  /** Bush base, % of the scene's width and height. */
  x: number;
  y: number;
  /** Depth scale (back rows are smaller). */
  scale: number;
  /** Center of this bush's circular focus icon, % of the scene. */
  iconX: number;
  iconY: number;
}

/** The most repositories the hillside holds; larger gardens use cards. */
export const HILLSIDE_CAPACITY = 64;

/**
 * Hill crest of the P2-A backdrop, % of height per 2 % of width
 * (measured). The relit hill layer that replaced it (ADR 0018) has a higher
 * crest, so a base below this line is on grass with room above it
 * (tests/ui/hillside.test.ts checks against the layer itself).
 */
const CREST = [
  79.1, 78.4, 77.8, 77.4, 76.7, 76.2, 75.8, 75.3, 74.9, 74.6, 74.2, 73.9, 73.5,
  73.2, 72.9, 72.6, 72.4, 72.2, 71.9, 71.7, 71.5, 71.3, 71.2, 71.1, 71.1, 71,
  71, 71, 71, 71, 71, 71.1, 71.2, 71.2, 71.3, 71.5, 71.7, 71.9, 72.3, 72.5,
  72.8, 73.1, 73.5, 73.9, 74.4, 74.8, 75.3, 75.9, 76.6, 77.2, 78,
];

export function crestAt(x: number): number {
  const i = Math.min(CREST.length - 2, Math.max(0, Math.floor(x / 2)));
  const t = x / 2 - i;
  return (CREST[i] ?? 0) * (1 - t) + (CREST[i + 1] ?? 0) * t;
}

/** The planted width of the hill, % of the scene: centered, edge to edge. */
const LEFT = 8;
const WIDTH = 84;
/** The lowest bush base, % of height (room below for the 44 px icon). */
const GROUND_BOTTOM = 97.5;
/**
 * A front (scale 1) plant's footprint, % of the scene's width: a typical
 * three-lane plant with its flowers (about 140 of 1920 design pixels).
 */
const FOOTPRINT = 7.3;
/** Narrowest column spacing that leaves room for 44 px icons plus jitter, %. */
const MIN_ICON_SPACING = 2.5;
/** The most a plant strays from its column, % of width. */
const MAX_X_JITTER = 2.5;
/** Up to this many plants, each gets its own column. */
export const COLUMN_LIMIT = Math.floor(WIDTH / MIN_ICON_SPACING / 1.05);
/** Beyond COLUMN_LIMIT: plants per staggered row. */
const ROW_WIDTH = 11;

/** Deterministic noise in [-1, 1], so a layout is the same on every load. */
function jitter(seed: number): number {
  const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * A plant at `x` (% of width) and `depth` (0 at the crest, 1 at the front).
 * Depth is spread part by perspective and part evenly; pure perspective
 * packs the back too tightly for focus icons.
 */
function slotAt(x: number, depth: number): HillsideSlot {
  // Keep clear of the crest, where the relit hill gives a plant no ground.
  depth = 0.1 + 0.9 * Math.min(1, Math.max(0, depth));
  const far = 1 - 0.55 * depth;
  const perspective = (1 / far - 1) / (1 / 0.45 - 1);
  const ground = 0.08 + 0.82 * (0.3 * perspective + 0.7 * depth);
  const crest = crestAt(x);
  const y = crest + (GROUND_BOTTOM - crest) * ground;
  return {
    x: round(x),
    y: round(y),
    scale: round(0.45 / far),
    iconX: round(x),
    iconY: round(y),
  };
}

/**
 * Where each of `count` repositories grows, in configuration order (at most
 * HILLSIDE_CAPACITY). A small garden reads left to right; a large one reads
 * back to front, then left to right. Positions depend on the count, so
 * adding a repository can move others; identities (ids, order) never change.
 */
export function hillsideLayout(count: number): HillsideSlot[] {
  const n = Math.max(0, Math.min(count, HILLSIDE_CAPACITY));
  if (n === 0) return [];
  const seed = n * 101;
  if (n <= COLUMN_LIMIT) {
    // One column each. Plants in the same band are `bands` columns apart,
    // which must cover a front plant's footprint.
    const spacing = WIDTH / n;
    const bands = Math.max(1, Math.ceil(FOOTPRINT / spacing));
    // X jitter (% of width) as large as the icons allow, up to a quarter
    // of a column and never more than MAX_X_JITTER.
    const xJitter = Math.min(
      0.25 * spacing,
      MAX_X_JITTER,
      Math.max(0, (spacing - MIN_ICON_SPACING) / 2),
    );
    return Array.from({ length: n }, (_, i) => {
      const x = LEFT + spacing * (i + 0.5) + xJitter * jitter(seed + i * 2);
      // Alternate columns between bands; with one band, depth wanders
      // across the middle of the hill.
      const band =
        bands === 1 ? 0 : i % bands === 0 ? bands - 1 : (i % bands) - 1;
      const size = 1 / bands;
      const depth =
        bands === 1
          ? 0.5 + 0.32 * jitter(seed + i * 2 + 1)
          : (band + 0.5 + 0.25 * jitter(seed + i * 2 + 1)) * size;
      return slotAt(x, depth);
    });
  }
  // Staggered rows, back to front, on one lattice: every row has the same
  // column spacing, odd rows shifted half a column, so neighbors in
  // adjacent rows never line up. Shorter rows spread over the lattice.
  const rows = Math.ceil(n / ROW_WIDTH);
  const columns = Math.ceil(n / rows);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const spacing = WIDTH / (columns + 0.5);
  const slots: HillsideSlot[] = [];
  for (let r = 0; r < rows; r++) {
    // Front rows are wider, so they take any remainder.
    const inRow = base + (r >= rows - extra ? 1 : 0);
    const offset = r % 2 === 0 ? 0 : 0.5;
    for (let c = 0; c < inRow; c++) {
      const column = spread(c, inRow, columns);
      const k = seed + (r * ROW_WIDTH + c) * 2;
      const x = LEFT + spacing * (column + 0.5 + offset + 0.05 * jitter(k));
      const depth = (r + 0.5 + 0.12 * jitter(k + 1)) / rows;
      slots.push(slotAt(x, depth));
    }
  }
  return slots;
}

/** The index of item `i` of `k` evenly spread over `size` positions (centered bins). */
function spread(i: number, k: number, size: number): number {
  return Math.min(size - 1, Math.round(((i + 0.5) * size) / k - 0.5));
}
