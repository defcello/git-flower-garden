/*
 * The wind over the hillside (ADR 0018, "Grass wind"): grass sways in
 * rolling waves as the wind pulses. Patches of bent grass (smooth lattice
 * noise) are carried downwind, a broader gust mask sweeps across faster and
 * strengthens the patches it crosses, and the whole field swells and
 * settles with the wind's own slow pulse. One field for the hill's grass
 * (in the GPU's shader, WIND_GLSL, and Software's sheen) and the plants'
 * sway (sway.ts), in 1920×1080 design pixels. Pure, so any moment of it is
 * testable; sway.ts keeps the travelled distance.
 */

/** The wind: m/s, its screen direction (+ blows right), and how far it has carried the waves. */
export interface WindField {
  speed: number;
  windX: number;
  /** Design pixels, accumulated (advance), so a new speed never jumps. */
  travel: number;
}

/** A multiple of every lattice period travel moves through: wrapping changes no sample. */
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
/** The lattice as the GPU reads it, row by row (an R32F texture). */
export const WIND_LATTICE = Float32Array.from(LATTICE);
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

/**
 * Patches of bent grass, smaller and slower toward the crest. On the ground
 * a front is about 2.6 times longer across the wind than along it, but the
 * hillside's depth is foreshortened about fourfold on screen, so on screen
 * a patch is wider than it is tall.
 */
export function waveShape(x: number, y: number, wind: WindField): number {
  const depth = 0.6 + 0.4 * Math.min(1, Math.max(0, (y - 650) / 430));
  const direction = windDirection(wind.windX);
  const px = (x - 960) / depth;
  const py = (y - 650) / depth;
  const travel = direction * wind.travel;
  const base =
    0.72 * noise((px - travel) / 250, py / 160) +
    0.28 *
      noise((px - travel * 0.75) / 125 + 19.7, py / 80 + wind.travel / 2000);
  const patch = gustPatch(x, y, wind);
  return (base * 2 - 1) * (0.25 + 0.75 * patch);
}

export function windWave(
  x: number,
  y: number,
  seconds: number,
  wind: WindField,
): number {
  return gustEnvelope(seconds, wind.speed) * waveShape(x, y, wind);
}

/**
 * The same lattice, interpolation, and scales as the CPU field above. The
 * shader declares `uniform highp sampler2D uLattice` (a 128×128 R32F
 * texture of WIND_LATTICE) and high float precision.
 */
export const WIND_GLSL = `
float windHash(vec2 p) {
  // The CPU's lattice, uploaded (WIND_LATTICE): no integer arithmetic,
  // whose precision phones may cut to 16 bits.
  return texelFetch(uLattice, ivec2(mod(p, 128.0)) & 127, 0).r;
}
float windNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mix(windHash(i), windHash(i + vec2(1.0, 0.0)), u.x);
  float b = mix(windHash(i + vec2(0.0, 1.0)), windHash(i + vec2(1.0)), u.x);
  return mix(a, b, u.y);
}
float windWave(vec2 p, float seconds, float speed, float windX, float travel) {
  float d = abs(windX) > 0.15 ? sign(windX) : 1.0;
  float depth = 0.6 + 0.4 * clamp((p.y - 650.0) / 430.0, 0.0, 1.0);
  vec2 q = (p - vec2(960.0, 650.0)) / depth;
  float base = 0.72 * windNoise(vec2((q.x - d * travel) / 250.0, q.y / 160.0)) +
               0.28 * windNoise(vec2((q.x - d * travel * 0.75) / 125.0 + 19.7,
                                      q.y / 80.0 + travel / 2000.0));
  float gustPatch = windNoise(vec2((q.x - d * travel * 1.5) / 500.0 + 31.3, q.y / 320.0 + 7.1));
  float tau = 6.283185307179586;
  float pulse = 0.5 * sin(tau * seconds / 11.0) +
                0.32 * sin(tau * seconds / 17.0 + 0.9) +
                0.18 * sin(tau * seconds / 29.0 + 1.7);
  float envelope = 1.0 - (0.04 + 0.64 * clamp(speed / 12.0, 0.0, 1.0)) * (0.5 - 0.5 * pulse);
  return envelope * (base * 2.0 - 1.0) * (0.25 + 0.75 * gustPatch);
}`;
