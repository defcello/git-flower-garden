/*
 * The wind over the hillside (ADR 0021): grass sways in rolling waves as
 * the wind pulses. Patches of bent grass (smooth lattice noise) are carried
 * downwind, a broader gust mask sweeps across faster and strengthens the
 * patches it crosses, and the whole field swells and settles with the
 * wind's own slow pulse. One field for the hill's grass tufts
 * (scene/grass.ts) and the plants' sway (sway.ts), in 1920×1080 design
 * pixels. Pure, so any moment of it is testable; sway.ts keeps the
 * travelled distance.
 */

/** The wind: m/s, its screen direction (+ blows right), and how far it has carried the waves. */
export interface WindField {
  speed: number;
  windX: number;
  /** Design pixels, accumulated (advance), so a new speed never jumps. */
  travel: number;
}

/** A multiple of every lattice period and of WAVELENGTH: wrapping changes no sample. */
export const TRAVEL_WRAP = 256000;
const TAU = 2 * Math.PI;
const lattice = (n: number) => ((n % 128) + 128) % 128;
function hash(x: number, y: number): number {
  let h =
    (Math.imul(lattice(x), 1664525) + Math.imul(lattice(y), 1013904223)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h & 65535) / 65535;
}
/** The lattice, hashed once: noise reads it for every sample. */
const LATTICE = new Float64Array(128 * 128);
for (let y = 0; y < 128; y++)
  for (let x = 0; x < 128; x++) LATTICE[y * 128 + x] = hash(x, y);
const at = (x: number, y: number) => LATTICE[(y & 127) * 128 + (x & 127)] ?? 0;
function noise(x: number, y: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy);
  const a = at(ix, iy),
    b = at(ix + 1, iy);
  const c = at(ix, iy + 1),
    d = at(ix + 1, iy + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** A forecast changes speed, not the distance the pattern already travelled. */
export function advance(travel: number, dt: number, speed: number): number {
  const step = Math.min(0.25, Math.max(0, dt));
  return (
    (((travel + step * waveSpeed(speed)) % TRAVEL_WRAP) + TRAVEL_WRAP) %
    TRAVEL_WRAP
  );
}
export function waveSpeed(speed: number): number {
  return 35 + 12 * Math.min(12, Math.max(0, speed));
}
export function windDirection(windX: number): number {
  return Math.abs(windX) > 0.15 ? Math.sign(windX) : 1;
}

/** Strong wind has deep lulls; still air keeps a nearly steady breeze. */
export function gustEnvelope(seconds: number, speed: number): number {
  const depth = 0.04 + 0.64 * Math.min(1, Math.max(0, speed) / 12);
  const pulse =
    0.5 * Math.sin((TAU * seconds) / 11) +
    0.32 * Math.sin((TAU * seconds) / 17 + 0.9) +
    0.18 * Math.sin((TAU * seconds) / 29 + 1.7);
  return 1 - depth * (0.5 - 0.5 * pulse);
}

/** The broad gust mask travels faster than the local grass pattern. */
export function gustPatch(x: number, y: number, wind: WindField): number {
  const depth = 0.6 + 0.4 * Math.min(1, Math.max(0, (y - 650) / 430));
  const px = (x - 960) / depth;
  const py = (y - 650) / depth;
  return noise(
    (px - windDirection(wind.windX) * wind.travel * 1.5) / 500 + 31.3,
    py / 320 + 7.1,
  );
}

/** Design pixels from one wave front to the next, along the wind, near. */
export const WAVELENGTH = 320;

/**
 * Waves of bent grass rolling downwind, smaller and slower toward the
 * crest: fronts across the wind, one WAVELENGTH apart, bent and broken by
 * slow noise so they never run in straight bars, with a little finer
 * texture, and strong only where a gust patch is passing. On the ground a
 * front runs across the wind, but the hillside's depth is foreshortened
 * about fourfold on screen, so the bends are tighter in depth than across.
 * Bounded by one.
 */
export function waveShape(x: number, y: number, wind: WindField): number {
  const depth = 0.6 + 0.4 * Math.min(1, Math.max(0, (y - 650) / 430));
  const direction = windDirection(wind.windX);
  const px = (x - 960) / depth;
  const py = (y - 650) / depth;
  const travel = direction * wind.travel;
  // How far each front is pushed ahead or held back: ±3.5 radians.
  const bend = 7 * (noise(px / 600 + 3.1, py / 220 + 11.3) - 0.5);
  const front = Math.sin((TAU * (px - travel)) / WAVELENGTH + bend);
  const fine =
    noise((px - travel * 0.75) / 125 + 19.7, py / 80 + wind.travel / 2000) * 2 -
    1;
  const p = gustPatch(x, y, wind);
  const patch = p * p * (3 - 2 * p);
  return (0.78 * front + 0.22 * fine) * (0.15 + 0.85 * patch);
}

export function windWave(
  x: number,
  y: number,
  seconds: number,
  wind: WindField,
): number {
  return gustEnvelope(seconds, wind.speed) * waveShape(x, y, wind);
}
