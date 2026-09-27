/*
 * The garden view's hillside: 64 fixed bush positions on the backdrop's
 * grass, each with its own fixed focus-icon position (roadmap section 7).
 * A fixed table, not a computed layout, so plant placement and icon spacing
 * are guaranteed by design: at 1920x1080 and larger, no two 44 px icons
 * overlap, so every icon is always reachable. Rows run back (0) to front (7),
 * columns left to right; slot = row * 8 + column. Generated once by
 * scripts/hillside-slots.ts and checked by tests/ui/hillside.test.ts against
 * the backdrop image itself.
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

export const HILLSIDE_ROWS = 8;
export const HILLSIDE_COLUMNS = 8;

export const HILLSIDE_SLOTS: readonly HillsideSlot[] = [
  { x: 15.74, y: 76.8, scale: 0.45, iconX: 15.74, iconY: 76.8 },
  { x: 25.63, y: 74.96, scale: 0.45, iconX: 25.63, iconY: 74.96 },
  { x: 34.35, y: 74.1, scale: 0.45, iconX: 34.35, iconY: 74.1 },
  { x: 43.18, y: 73.53, scale: 0.45, iconX: 43.18, iconY: 73.53 },
  { x: 51.89, y: 72.97, scale: 0.45, iconX: 51.89, iconY: 72.97 },
  { x: 61.77, y: 73.41, scale: 0.45, iconX: 61.77, iconY: 73.41 },
  { x: 70.65, y: 73.71, scale: 0.45, iconX: 70.65, iconY: 73.71 },
  { x: 79.26, y: 74.8, scale: 0.45, iconX: 79.26, iconY: 74.8 },
  { x: 19.74, y: 78.2, scale: 0.49, iconX: 19.74, iconY: 78.2 },
  { x: 29.06, y: 77.26, scale: 0.49, iconX: 29.06, iconY: 77.26 },
  { x: 37.58, y: 76.58, scale: 0.49, iconX: 37.58, iconY: 76.58 },
  { x: 47.82, y: 75.87, scale: 0.49, iconX: 47.82, iconY: 75.87 },
  { x: 57.17, y: 75.77, scale: 0.49, iconX: 57.17, iconY: 75.77 },
  { x: 66.15, y: 75.98, scale: 0.49, iconX: 66.15, iconY: 75.98 },
  { x: 76.19, y: 76.89, scale: 0.49, iconX: 76.19, iconY: 76.89 },
  { x: 84.7, y: 78.15, scale: 0.49, iconX: 84.7, iconY: 78.15 },
  { x: 13.72, y: 81.81, scale: 0.53, iconX: 13.72, iconY: 81.81 },
  { x: 23.06, y: 80.16, scale: 0.53, iconX: 23.06, iconY: 80.16 },
  { x: 33.9, y: 79.49, scale: 0.53, iconX: 33.9, iconY: 79.49 },
  { x: 43.1, y: 78.84, scale: 0.53, iconX: 43.1, iconY: 78.84 },
  { x: 53, y: 78.37, scale: 0.53, iconX: 53, iconY: 78.37 },
  { x: 62.62, y: 78.38, scale: 0.53, iconX: 62.62, iconY: 78.38 },
  { x: 70.97, y: 79.14, scale: 0.53, iconX: 70.97, iconY: 79.14 },
  { x: 81.54, y: 79.97, scale: 0.53, iconX: 81.54, iconY: 79.97 },
  { x: 18.31, y: 83.57, scale: 0.59, iconX: 18.31, iconY: 83.57 },
  { x: 27.15, y: 82.58, scale: 0.59, iconX: 27.15, iconY: 82.58 },
  { x: 37.97, y: 81.84, scale: 0.59, iconX: 37.97, iconY: 81.84 },
  { x: 46.96, y: 81.39, scale: 0.59, iconX: 46.96, iconY: 81.39 },
  { x: 58.13, y: 81.19, scale: 0.59, iconX: 58.13, iconY: 81.19 },
  { x: 66.92, y: 81.28, scale: 0.59, iconX: 66.92, iconY: 81.28 },
  { x: 77.15, y: 81.94, scale: 0.59, iconX: 77.15, iconY: 81.94 },
  { x: 87.47, y: 83.23, scale: 0.59, iconX: 87.47, iconY: 83.23 },
  { x: 11.22, y: 86.93, scale: 0.66, iconX: 11.22, iconY: 86.93 },
  { x: 21.56, y: 85.69, scale: 0.66, iconX: 21.56, iconY: 85.69 },
  { x: 32.11, y: 84.84, scale: 0.66, iconX: 32.11, iconY: 84.84 },
  { x: 41.67, y: 84.18, scale: 0.66, iconX: 41.67, iconY: 84.18 },
  { x: 52.79, y: 84.02, scale: 0.66, iconX: 52.79, iconY: 84.02 },
  { x: 63.59, y: 84.37, scale: 0.66, iconX: 63.59, iconY: 84.37 },
  { x: 72.74, y: 84.65, scale: 0.66, iconX: 72.74, iconY: 84.65 },
  { x: 83.05, y: 85.34, scale: 0.66, iconX: 83.05, iconY: 85.34 },
  { x: 15.98, y: 88.84, scale: 0.74, iconX: 15.98, iconY: 88.84 },
  { x: 26.7, y: 88.01, scale: 0.74, iconX: 26.7, iconY: 88.01 },
  { x: 36.96, y: 87.54, scale: 0.74, iconX: 36.96, iconY: 87.54 },
  { x: 46.68, y: 87.7, scale: 0.74, iconX: 46.68, iconY: 87.7 },
  { x: 57.95, y: 87.22, scale: 0.74, iconX: 57.95, iconY: 87.22 },
  { x: 69.06, y: 87.45, scale: 0.74, iconX: 69.06, iconY: 87.45 },
  { x: 79.55, y: 88.11, scale: 0.74, iconX: 79.55, iconY: 88.11 },
  { x: 89.12, y: 88.81, scale: 0.74, iconX: 89.12, iconY: 88.81 },
  { x: 8.91, y: 92.2, scale: 0.85, iconX: 8.91, iconY: 92.2 },
  { x: 20.72, y: 91.48, scale: 0.85, iconX: 20.72, iconY: 91.48 },
  { x: 31.53, y: 91.22, scale: 0.85, iconX: 31.53, iconY: 91.22 },
  { x: 41.77, y: 91.21, scale: 0.85, iconX: 41.77, iconY: 91.21 },
  { x: 52.49, y: 90.9, scale: 0.85, iconX: 52.49, iconY: 90.9 },
  { x: 63.65, y: 90.82, scale: 0.85, iconX: 63.65, iconY: 90.82 },
  { x: 73.91, y: 90.98, scale: 0.85, iconX: 73.91, iconY: 90.98 },
  { x: 86.17, y: 91.89, scale: 0.85, iconX: 86.17, iconY: 91.89 },
  { x: 13.11, y: 95.22, scale: 1, iconX: 13.11, iconY: 95.22 },
  { x: 24.43, y: 94.94, scale: 1, iconX: 24.43, iconY: 94.94 },
  { x: 36.12, y: 94.95, scale: 1, iconX: 36.12, iconY: 94.95 },
  { x: 47.34, y: 94.64, scale: 1, iconX: 47.34, iconY: 94.64 },
  { x: 58.46, y: 94.86, scale: 1, iconX: 58.46, iconY: 94.86 },
  { x: 69.34, y: 94.83, scale: 1, iconX: 69.34, iconY: 94.83 },
  { x: 81.64, y: 94.88, scale: 1, iconX: 81.64, iconY: 94.88 },
  { x: 92.92, y: 95.45, scale: 1, iconX: 92.92, iconY: 95.45 },
];

/**
 * The slots used by `count` repositories (at most 64), spread evenly over
 * the hillside: repositories are divided over evenly spaced rows, and each
 * row's plants over evenly spaced columns. Configuration order fills rows
 * back to front, left to right. Positions depend on the count, so adding a
 * repository can move others; identities (ids, order) never change.
 */
export function hillsideSlots(count: number): number[] {
  if (count <= 0) return [];
  const n = Math.min(count, HILLSIDE_SLOTS.length);
  const rows = Math.max(
    Math.round(Math.sqrt(n)),
    Math.ceil(n / HILLSIDE_COLUMNS),
  );
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const slots: number[] = [];
  for (let r = 0; r < rows; r++) {
    // Front rows are wider, so they take any remainder.
    const inRow = base + (r >= rows - extra ? 1 : 0);
    const row = spread(r, rows, HILLSIDE_ROWS);
    for (let c = 0; c < inRow; c++) {
      slots.push(row * HILLSIDE_COLUMNS + spread(c, inRow, HILLSIDE_COLUMNS));
    }
  }
  return slots;
}

/** The index of item `i` of `k` evenly spread over `size` positions (centered bins). */
function spread(i: number, k: number, size: number): number {
  return Math.min(size - 1, Math.round(((i + 0.5) * size) / k - 0.5));
}
