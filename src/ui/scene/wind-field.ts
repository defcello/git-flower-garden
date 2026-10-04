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

/**
 * The wind: m/s, where it blows on the ground (`windX`: + to the right;
 * `windZ`: + away from the viewer, into the scene), how strong its gusts
 * are, and how far it has carried the waves.
 */
export interface WindField {
  speed: number;
  windX: number;
  /** m/s away from the viewer; 0 when not given. */
  windZ?: number;
  /** m/s the gusts blow above `speed`; when not given, gustsOf(speed). */
  gust?: number;
  /** Design pixels, accumulated (advance), so a new speed never jumps. */
  travel: number;
}

/** Typical gusts, when the forecast gives none: half again the mean wind. */
export function gustsOf(speed: number): number {
  return 0.5 * Math.max(0, speed);
}

/** The gusts of `wind`, m/s above its mean. */
export function windGust(wind: WindField): number {
  return Math.max(0, wind.gust ?? gustsOf(wind.speed));
}

/**
 * The hillside's depth is foreshortened on screen: a distance into the
 * scene looks this many times shorter than the same distance across.
 */
export const FORESHORTEN = 3;

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
/**
 * Seconds between one wave front and the next passing a place: shorter as
 * the wind rises, from about 16 in still air to 2 in a storm.
 */
export function wavePeriod(speed: number): number {
  return 2 + 14 * Math.exp(-Math.max(0, speed) / 6);
}
/** Design pixels a second the waves travel: one WAVELENGTH each wavePeriod. */
export function waveSpeed(speed: number): number {
  return WAVELENGTH / wavePeriod(speed);
}
export function windDirection(windX: number): number {
  return Math.abs(windX) > 0.15 ? Math.sign(windX) : 1;
}

/**
 * Where the wind blows on the ground, as a unit vector (x: right, z: away
 * from the viewer); to the right in still air.
 */
export function windHeading(wind: WindField): { x: number; z: number } {
  const z = wind.windZ ?? 0;
  const length = Math.hypot(wind.windX, z);
  if (length < 0.15) return { x: 1, z: 0 };
  return { x: wind.windX / length, z: z / length };
}

/** Gusty wind has deep lulls; steady air keeps a nearly steady breeze. */
export function gustEnvelope(seconds: number, gust: number): number {
  const depth = 0.04 + 0.64 * Math.min(1, Math.max(0, gust) / 6);
  const pulse =
    0.5 * Math.sin((TAU * seconds) / 11) +
    0.32 * Math.sin((TAU * seconds) / 17 + 0.9) +
    0.18 * Math.sin((TAU * seconds) / 29 + 1.7);
  return 1 - depth * (0.5 - 0.5 * pulse);
}

/**
 * A place on the hill, in the wave's own coordinates (smaller toward the
 * crest), with the part of the wave that never moves there: how far its
 * fronts are pushed ahead or held back. Made once per tuft.
 */
export interface WaveSite {
  px: number;
  py: number;
  /** ±3.5 radians, from slow noise. */
  bend: number;
}

export function waveSite(x: number, y: number): WaveSite {
  const depth = 0.6 + 0.4 * Math.min(1, Math.max(0, (y - 650) / 430));
  const px = (x - 960) / depth;
  const py = (y - 650) / depth;
  return { px, py, bend: 7 * (noise(px / 600 + 3.1, py / 220 + 11.3) - 0.5) };
}

/** The broad gust mask at a site, carried by `travel` toward `heading`. */
function siteGust(
  site: WaveSite,
  travel: number,
  heading: { x: number; z: number },
): number {
  const shift = travel * 1.5;
  // Carried downwind on the ground: into the scene is up the screen, and
  // foreshortened.
  return noise(
    (site.px - heading.x * shift) / 500 + 31.3,
    (site.py + (heading.z * shift) / FORESHORTEN) / 320 + 7.1,
  );
}

/** The broad gust mask travels faster than the local grass pattern. */
export function gustPatch(x: number, y: number, wind: WindField): number {
  return siteGust(waveSite(x, y), wind.travel, windHeading(wind));
}

/** Design pixels from one wave front to the next, along the wind, near. */
export const WAVELENGTH = 640;

/**
 * Waves of bent grass rolling downwind, smaller and slower toward the
 * crest: fronts across the wind, one WAVELENGTH apart on the ground,
 * bent and broken by slow noise so they never run in straight bars, with a
 * little finer texture, and strong only where a gust patch is passing. A
 * wind across the view sends the fronts sideways; one into the scene or
 * toward the viewer, up or down the hill, foreshortened (FORESHORTEN).
 * Bounded by one.
 */
export function waveShape(x: number, y: number, wind: WindField): number {
  return siteWave(waveSite(x, y), wind.travel, windHeading(wind));
}

/** waveShape at a site, for the wind's `travel` and `heading` (windHeading). */
export function siteWave(
  site: WaveSite,
  travel: number,
  heading: { x: number; z: number },
): number {
  const { px, py } = site;
  // On the ground: across, and into the scene (up the screen).
  const along = px * heading.x - py * FORESHORTEN * heading.z;
  const front = Math.sin((TAU * (along - travel)) / WAVELENGTH + site.bend);
  const shift = travel * 0.75;
  const fine =
    noise(
      (px - heading.x * shift) / 125 + 19.7,
      (py + (heading.z * shift) / FORESHORTEN) / 80 + travel / 2000,
    ) *
      2 -
    1;
  const p = siteGust(site, travel, heading);
  const patch = p * p * (3 - 2 * p);
  return (0.78 * front + 0.22 * fine) * (0.15 + 0.85 * patch);
}

export function windWave(
  x: number,
  y: number,
  seconds: number,
  wind: WindField,
): number {
  return gustEnvelope(seconds, windGust(wind)) * waveShape(x, y, wind);
}
