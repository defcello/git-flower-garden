/*
 * Generates the garden view's 64 fixed hillside slots (bush bases and focus
 * icon positions) and checks them. The table is committed as literals in
 * src/ui/hillside.ts; this script only documents and reproduces how it was
 * made. Run: node scripts/hillside-slots.ts [--check]
 *
 * Coordinates are percentages of the scene (the viewport). The backdrop is a
 * `cover` background anchored center-bottom, so 16:9 is the worst case for
 * "on the grass": wider screens crop sky, taller screens crop the sides where
 * the hill is lower.
 */

/**
 * Hill crest of the P2-A backdrop (now docs/art/p2a/blue-ridge-day.png), %
 * of height per 2 % of width (measured). The table was generated against it;
 * tests/ui/hillside.test.ts checks it against the relit hill layer that
 * replaced it (ADR 0018), whose crest is higher, so every slot stays on grass.
 */
export const CREST = [
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

const ROWS = 8;
const COLUMNS = 8;
/** The lowest bush base, % of height (room below for the 44 px icon). */
const GROUND_BOTTOM = 97.5;

/** Deterministic jitter in [-1, 1] so rows do not read as a grid. */
function jitter(seed: number): number {
  const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

export function generate() {
  const slots = [];
  for (let r = 0; r < ROWS; r++) {
    // Depth from 1 (back) to 0.45 (front); scale follows 1 / depth.
    const depth = 1 - (r * 0.55) / (ROWS - 1);
    const perspective = (1 / depth - 1) / (1 / 0.45 - 1);
    // Part true perspective, part even spacing: pure perspective packs the
    // back rows too tightly for 44 px focus icons.
    const ground = 0.08 + 0.82 * (0.3 * perspective + (0.7 * r) / (ROWS - 1));
    const halfWidth = 36 + (9 * r) / (ROWS - 1);
    const stagger = r % 2 === 0 ? -0.25 : 0.25;
    for (let c = 0; c < COLUMNS; c++) {
      const u = (c + 0.5 + stagger) / COLUMNS;
      const x = 50 + (u * 2 - 1) * halfWidth + 0.8 * jitter(r * 8 + c);
      const crest = crestAt(x);
      const y =
        crest +
        (GROUND_BOTTOM - crest) * ground +
        0.25 * jitter(100 + r * 8 + c);
      slots.push({
        x: round(x),
        y: round(y),
        scale: round(0.45 / depth),
        iconX: round(x),
        iconY: round(y),
      });
    }
  }
  return slots;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** The smallest separation of two 44 px icons, as max(|dx|, |dy|), in px. */
export function minIconSeparation(
  slots: readonly { iconX: number; iconY: number }[],
  width: number,
  height: number,
): number {
  let min = Infinity;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i],
        b = slots[j];
      if (!a || !b) continue;
      const dx = (Math.abs(a.iconX - b.iconX) * width) / 100;
      const dy = (Math.abs(a.iconY - b.iconY) * height) / 100;
      min = Math.min(min, Math.max(dx, dy));
    }
  }
  return min;
}

if (process.argv[1]?.endsWith("hillside-slots.ts")) {
  const slots = generate();
  const sep = minIconSeparation(slots, 1920, 1080);
  const grass = Math.min(...slots.map((s) => s.y - crestAt(s.x)));
  console.error(
    `min icon separation at 1920x1080: ${sep.toFixed(1)} px; min height above crest: ${grass.toFixed(2)} %`,
  );
  if (!process.argv.includes("--check")) {
    for (const s of slots)
      console.log(
        `  { x: ${String(s.x)}, y: ${String(s.y)}, scale: ${String(s.scale)}, iconX: ${String(s.iconX)}, iconY: ${String(s.iconY)} },`,
      );
  }
}
