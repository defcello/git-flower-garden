/**
 * Scene lighting from the environment (ADR 0018). Pure: the same snapshot
 * always gives the same state, so both drawing tiers light the scene alike.
 *
 * The sky is a stylized panorama (roadmap P2-D): east is always at the left
 * edge and west at the right, with the meridian the Sun crosses at noon in
 * the middle, whichever way the monitor faces. Altitude stays physical.
 */
import type { BodyPosition } from "./astronomy.ts";
import type { EnvironmentSnapshot } from "./environment.ts";

/** sRGB, each channel 0..1. */
export type Color = readonly [number, number, number];

/** Scene space: x to the right, y up, z out of the screen toward the viewer. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export type Twilight = "day" | "civil" | "nautical" | "astronomical" | "night";

export interface SkyBody {
  /** Horizontal panorama position: 0 east (left), 0.5 noon meridian, 1 west (right). */
  u: number;
  /** Degrees above the horizon; negative below it. */
  altitude: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
  aboveHorizon: boolean;
  /** In the half of the sky behind the viewer, folded onto the panorama. */
  behind: boolean;
  /** Unit vector toward the body, in scene space (unfolded). */
  direction: Vector3;
  color: Color;
  /** Direct light it casts on the scene, 0..1. */
  intensity: number;
  /** Apparent radius of the disc, degrees. */
  radius: number;
}

export interface MoonBody extends SkyBody {
  /** Moon minus Sun ecliptic longitude: 0 new, 90 first quarter, 180 full, 270 last quarter. */
  phaseDegrees: number;
  illuminatedFraction: number;
  waxing: boolean;
  /**
   * Direction of the lit limb on screen, degrees counterclockwise from
   * screen right (y up). Points toward the Sun, independent of the phase.
   */
  limbAngle: number;
}

export interface LightingState {
  twilight: Twilight;
  /** The Sun is on its rising (morning) side of the sky. */
  rising: boolean;
  sun: SkyBody;
  moon: MoonBody;
  sky: { zenith: Color; horizon: Color };
  ambient: Color;
  /** Atmospheric haze over distant layers, 0..1. */
  haze: number;
  /** Star visibility, 0..1. */
  stars: number;
  /** Ground shadow cast away from the Sun; null when it is down. */
  shadow: { x: number; z: number; length: number } | null;
  /**
   * The point of the sky opposite the Sun, which a rainbow circles: across
   * (`u`), the Sun's place mirrored, and degrees above the horizon (below
   * it while the Sun is up). It is behind the viewer, so it has no place of
   * its own on the panorama: placed by its hour angle, it wrapped from one
   * edge to the other at solar noon. Mirrored, it moves smoothly against
   * the Sun all day, still west in the morning and east in the afternoon.
   */
  antisolar: { u: number; altitude: number };
  eclipse: Eclipse;
}

/** How the Moon and the Sun, or the Earth's shadow, overlap now. */
export interface Eclipse {
  /** Degrees between the centres of the Moon and the Sun, as seen. */
  separation: number;
  /** Fraction of the Sun's disc the Moon covers, 0..1 (a solar eclipse). */
  solar: number;
  /**
   * The corona's visibility, 0..1: it shows only as the last of the Sun's
   * disc is covered (a total eclipse), never through an annular one.
   */
  corona: number;
  /** The Earth's shadow at the Moon, in Moon radii (astronomy.ts). */
  shadow: { distance: number; umbra: number; penumbra: number };
  /** Fractions of the Moon's disc in the umbra and the penumbra (a lunar eclipse). */
  umbra: number;
  penumbra: number;
}

const DEG = Math.PI / 180;

/**
 * Area common to two discs of radii `a` and `b` whose centres are `d`
 * apart, as a fraction of the first disc's area.
 */
export function discOverlap(a: number, b: number, d: number): number {
  if (a <= 0) return 0;
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.min(1, (b * b) / (a * a));
  const angleA = Math.acos(clamp((d * d + a * a - b * b) / (2 * d * a), -1, 1));
  const angleB = Math.acos(clamp((d * d + b * b - a * a) / (2 * d * b), -1, 1));
  const lens =
    a * a * (angleA - Math.sin(2 * angleA) / 2) +
    b * b * (angleB - Math.sin(2 * angleB) / 2);
  return clamp(lens / (Math.PI * a * a), 0, 1);
}

/** Eclipses from the sky's geometry. */
function eclipseOf(sky: EnvironmentSnapshot["sky"]): Eclipse {
  const { sun, moon } = sky;
  const solar = discOverlap(sun.radius, moon.radius, moon.separation);
  // Covered to within a hair of the whole disc: the corona and the
  // brightest stars come out over the last moments before totality.
  const corona = moon.radius >= sun.radius ? smoothstep(0.985, 1, solar) : 0;
  const shadow = moon.shadow;
  return {
    separation: moon.separation,
    solar,
    corona,
    shadow,
    umbra: discOverlap(1, shadow.umbra, shadow.distance),
    penumbra: discOverlap(1, shadow.penumbra, shadow.distance),
  };
}

/**
 * How much of its light the eclipsed Sun still seems to give, 0..1: the
 * eye adapts, so a half-covered Sun barely dims the day, while the last
 * percent of the disc goes dark all at once.
 */
export const eclipseDaylight = (solar: number) => Math.pow(1 - solar, 0.35);

/** The sky of nautical twilight, which a total eclipse brings at midday. */
const TOTALITY_ALTITUDE = -9;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const mix = (a: Color, b: Color, t: number): Color => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Degrees from east toward the facing meridian, in (-180, 180]. */
function fromEast(azimuth: number, latitude: number): number {
  // North of the equator the noon Sun is to the south, so the viewer faces
  // south; south of it, north. Either way east is on the left.
  const d = latitude >= 0 ? azimuth - 90 : 90 - azimuth;
  const wrapped = ((((d + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

interface Projected {
  u: number;
  behind: boolean;
  direction: Vector3;
}

/**
 * Hour angle in degrees, (-180, 180]: 0 on the meridian, negative before it
 * (rising), positive after (setting). It only ever increases through a day.
 */
function hourAngle(position: BodyPosition, latitude: number): number {
  const v = horizontalVector(position.altitude, position.azimuth);
  const phi = latitude * DEG;
  // The equator's upper meridian point, and west: H = atan2(v·west, v·Q).
  const q = -v.n * Math.sin(phi) + v.u * Math.cos(phi);
  return Math.atan2(-v.e, q) / DEG;
}

export function project(position: BodyPosition, latitude: number): Projected {
  const d = fromEast(position.azimuth, latitude);
  const cosAlt = Math.cos(position.altitude * DEG);
  const h = hourAngle(position, latitude);
  return {
    // Placed by hour angle, so a body never turns back, and squeezed at the
    // edges like the compressed east and west of the panorama: rising and
    // setting look steep, the middle of the path a broad arc. Due east or
    // west of the meridian is at 0.15 or 0.85; only a circumpolar body ever
    // reaches the edges, at lower culmination.
    u: 0.5 + 0.5 * Math.sin((h / 2) * DEG),
    behind: d < 0,
    direction: {
      x: -Math.cos(d * DEG) * cosAlt,
      y: Math.sin(position.altitude * DEG),
      z: -Math.sin(d * DEG) * cosAlt,
    },
  };
}

interface SkyKey {
  altitude: number;
  zenith: Color;
  horizon: Color;
  ambient: Color;
  haze: number;
}

// Keyed by Sun altitude. Twilight boundaries at -18, -12, -6 degrees.
const SKY: readonly [SkyKey, ...SkyKey[]] = [
  {
    altitude: -18,
    zenith: [0.02, 0.03, 0.08],
    horizon: [0.04, 0.05, 0.12],
    ambient: [0.05, 0.06, 0.12],
    haze: 0.15,
  },
  {
    altitude: -12,
    zenith: [0.04, 0.06, 0.16],
    horizon: [0.1, 0.12, 0.25],
    ambient: [0.08, 0.09, 0.18],
    haze: 0.2,
  },
  {
    altitude: -6,
    zenith: [0.1, 0.15, 0.35],
    horizon: [0.55, 0.38, 0.4],
    ambient: [0.22, 0.22, 0.32],
    haze: 0.35,
  },
  {
    altitude: -1,
    zenith: [0.22, 0.35, 0.6],
    horizon: [0.95, 0.58, 0.38],
    ambient: [0.45, 0.4, 0.42],
    haze: 0.55,
  },
  {
    altitude: 4,
    zenith: [0.3, 0.5, 0.8],
    horizon: [0.98, 0.78, 0.58],
    ambient: [0.62, 0.6, 0.6],
    haze: 0.5,
  },
  {
    altitude: 15,
    zenith: [0.25, 0.5, 0.88],
    horizon: [0.75, 0.85, 0.95],
    ambient: [0.8, 0.82, 0.85],
    haze: 0.35,
  },
  {
    altitude: 90,
    zenith: [0.2, 0.45, 0.9],
    horizon: [0.7, 0.83, 0.96],
    ambient: [0.9, 0.92, 0.95],
    haze: 0.25,
  },
];

function skyAt(altitude: number): Omit<SkyKey, "altitude"> {
  let below: SkyKey | undefined;
  for (const key of SKY) {
    if (key.altitude >= altitude) {
      if (below === undefined) return key;
      const t = (altitude - below.altitude) / (key.altitude - below.altitude);
      return {
        zenith: mix(below.zenith, key.zenith, t),
        horizon: mix(below.horizon, key.horizon, t),
        ambient: mix(below.ambient, key.ambient, t),
        haze: below.haze + (key.haze - below.haze) * t,
      };
    }
    below = key;
  }
  return below ?? SKY[0];
}

const SUN_LOW: Color = [1, 0.45, 0.25];
const SUN_HIGH: Color = [1, 0.97, 0.92];
const MOON_LIGHT: Color = [0.72, 0.8, 1];

export function twilightFor(sunAltitude: number): Twilight {
  if (sunAltitude >= 0) return "day";
  if (sunAltitude >= -6) return "civil";
  if (sunAltitude >= -12) return "nautical";
  if (sunAltitude >= -18) return "astronomical";
  return "night";
}

/** Unit vector toward a horizontal position (x east, y north, z up). */
function horizontalVector(altitude: number, azimuth: number) {
  const c = Math.cos(altitude * DEG);
  return {
    e: c * Math.sin(azimuth * DEG),
    n: c * Math.cos(azimuth * DEG),
    u: Math.sin(altitude * DEG),
  };
}

/**
 * Screen angle of the Moon's lit limb: the direction, on the panorama, of a
 * short step from the Moon along the great circle toward the Sun.
 */
function limbAngle(
  moon: BodyPosition,
  sun: BodyPosition,
  latitude: number,
): number {
  const m = horizontalVector(moon.altitude, moon.azimuth);
  const s = horizontalVector(sun.altitude, sun.azimuth);
  const dot = clamp(m.e * s.e + m.n * s.n + m.u * s.u, -1, 1);
  // Component of the Sun direction perpendicular to the Moon direction.
  const p = { e: s.e - dot * m.e, n: s.n - dot * m.n, u: s.u - dot * m.u };
  const length = Math.hypot(p.e, p.n, p.u);
  if (length < 1e-9) return 0; // Sun and Moon coincide: no defined limb.
  const step = 0.5 * DEG;
  const e = m.e * Math.cos(step) + (p.e / length) * Math.sin(step);
  const n = m.n * Math.cos(step) + (p.n / length) * Math.sin(step);
  const u = m.u * Math.cos(step) + (p.u / length) * Math.sin(step);
  const toward = {
    altitude: Math.asin(clamp(u, -1, 1)) / DEG,
    azimuth: (((Math.atan2(e, n) / DEG) % 360) + 360) % 360,
  };
  const from = project(moon, latitude);
  const to = project(toward, latitude);
  // Horizontal panorama units are 180 degrees wide, like altitude degrees.
  const dx = (to.u - from.u) * 180;
  const dy = toward.altitude - moon.altitude;
  return Math.atan2(dy, dx) / DEG;
}

export function lightingState(snapshot: EnvironmentSnapshot): LightingState {
  const { sun, moon } = snapshot.sky;
  const latitude = snapshot.place.latitude;
  const sunAltitude = sun.altitude;
  const eclipse = eclipseOf(snapshot.sky);
  // The covered Sun lights the scene less, and at totality the sky turns
  // to twilight around it.
  const daylight = eclipseDaylight(eclipse.solar);
  const sunIntensity = smoothstep(-1, 8, sunAltitude) * daylight;
  // The Moon in the umbra keeps only a dim red glow; the penumbra barely
  // dims it.
  const moonShade = 1 - 0.95 * eclipse.umbra - 0.25 * eclipse.penumbra;
  const sunProjected = project(sun, latitude);
  const moonProjected = project(moon, latitude);
  const moonUp = moon.altitude > 0;
  const moonIntensity = moonUp
    ? 0.25 *
      moon.illuminatedFraction *
      Math.max(0, moonShade) *
      Math.sin(moon.altitude * DEG) *
      (1 - sunIntensity)
    : 0;
  const daySky = skyAt(sunAltitude);
  const dark = sunAltitude > 0 ? 1 - daylight : 0;
  const nightSky = skyAt(Math.min(sunAltitude, TOTALITY_ALTITUDE));
  const sky = {
    zenith: mix(daySky.zenith, nightSky.zenith, dark),
    horizon: mix(daySky.horizon, nightSky.horizon, dark),
    ambient: mix(daySky.ambient, nightSky.ambient, dark),
    haze: daySky.haze + (nightSky.haze - daySky.haze) * dark,
  };

  let shadow: LightingState["shadow"] = null;
  if (sunAltitude > 0) {
    const horizontal = Math.hypot(
      sunProjected.direction.x,
      sunProjected.direction.z,
    );
    const length = Math.min(8, 1 / Math.tan(Math.max(sunAltitude, 0.1) * DEG));
    shadow = {
      x: horizontal > 0 ? -sunProjected.direction.x / horizontal : 0,
      z: horizontal > 0 ? -sunProjected.direction.z / horizontal : 0,
      length,
    };
  }

  return {
    twilight: twilightFor(sunAltitude),
    rising: sun.azimuth > 0 && sun.azimuth < 180,
    sun: {
      ...sunProjected,
      altitude: sunAltitude,
      azimuth: sun.azimuth,
      aboveHorizon: sunAltitude > 0,
      color: mix(SUN_LOW, SUN_HIGH, smoothstep(0, 20, sunAltitude)),
      intensity: sunIntensity,
      radius: sun.radius,
    },
    moon: {
      ...moonProjected,
      altitude: moon.altitude,
      azimuth: moon.azimuth,
      aboveHorizon: moonUp,
      color: MOON_LIGHT,
      intensity: moonIntensity,
      phaseDegrees: moon.phaseDegrees,
      illuminatedFraction: moon.illuminatedFraction,
      waxing: moon.phaseDegrees < 180,
      limbAngle: limbAngle(moon, sun, latitude),
      radius: moon.radius,
    },
    sky: { zenith: sky.zenith, horizon: sky.horizon },
    ambient: sky.ambient,
    haze: sky.haze,
    stars: Math.max(
      1 - smoothstep(-15, -4, sunAltitude),
      // Only the brightest at totality.
      0.6 * eclipse.corona,
    ),
    shadow,
    antisolar: {
      u: 1 - sunProjected.u,
      altitude: -sun.altitude,
    },
    eclipse,
  };
}
