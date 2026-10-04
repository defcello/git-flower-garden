/**
 * Sun and Moon positions for the scene's lighting (ADR 0018), computed offline
 * by the vendored astronomy-engine (reviewed and pinned, ADR 0019). Pure: the
 * caller supplies the time and the place; nothing here reads a clock or the
 * network.
 *
 * This is the only module that imports the library (enforced by ESLint).
 * Some of its functions never return on a non-finite number, and it throws
 * strings rather than Errors, so inputs are checked here first (ADR 0019).
 */
import {
  AngleBetween,
  Body,
  Equator,
  GeoMoon,
  GeoVector,
  Horizon,
  Illumination,
  KM_PER_AU,
  MoonPhase,
  Observer,
  type EquatorialCoordinates,
} from "#astronomy-engine";

/** The library's radii (astronomy.js), which it does not export. */
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;
/** The Earth with the atmosphere that widens its shadow on the Moon. */
const EARTH_SHADOW_RADIUS_KM = 6371 + 88;

export interface Place {
  /** Degrees north, -90..90. */
  latitude: number;
  /** Degrees east, -180..180. */
  longitude: number;
  /** Meters above sea level. */
  elevationMeters?: number;
}

export interface BodyPosition {
  /** Degrees above the horizon, corrected for atmospheric refraction. */
  altitude: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
}

export interface SkyBodies {
  sun: BodyPosition & {
    /** Apparent radius of the disc, degrees, from the observer. */
    radius: number;
  };
  moon: BodyPosition & {
    /** Lit fraction of the disc, 0 (new) to 1 (full). */
    illuminatedFraction: number;
    /** Moon minus Sun ecliptic longitude: 0 new, 90 first quarter, 180 full, 270 last quarter. */
    phaseDegrees: number;
    /** Apparent radius of the disc, degrees, from the observer. */
    radius: number;
    /**
     * Degrees between the centres of the Moon and the Sun, as the observer
     * sees them (topocentric): under the sum of the radii, a solar eclipse.
     */
    separation: number;
    /**
     * The Earth's shadow where the Moon is, in Moon radii: the Moon's
     * distance from its axis and the radii of the umbra and penumbra
     * (the library's own model, astronomy.js `EarthShadow`). The Moon is
     * in a lunar eclipse while `distance` is under `penumbra + 1`.
     */
    shadow: { distance: number; umbra: number; penumbra: number };
  };
}

function position(
  body: Body,
  time: Date,
  observer: Observer,
): { horizontal: BodyPosition; equatorial: EquatorialCoordinates } {
  const equatorial = Equator(body, time, observer, true, true);
  const horizontal = Horizon(
    time,
    observer,
    equatorial.ra,
    equatorial.dec,
    "normal",
  );
  return {
    horizontal: { altitude: horizontal.altitude, azimuth: horizontal.azimuth },
    equatorial,
  };
}

/** Apparent radius in degrees of a body `radiusKm` across at `au`. */
const apparent = (radiusKm: number, au: number) =>
  (Math.asin(Math.min(1, radiusKm / (au * KM_PER_AU))) * 180) / Math.PI;

/** The Earth's shadow at the Moon, as astronomy.js `EarthShadow` finds it. */
function earthShadow(time: Date): SkyBodies["moon"]["shadow"] {
  const s = GeoVector(Body.Sun, time, true);
  const m = GeoMoon(time);
  // Sunlight through the Earth's centre runs along -s.
  const u =
    -(s.x * m.x + s.y * m.y + s.z * m.z) / (s.x * s.x + s.y * s.y + s.z * s.z);
  // Toward the Sun (near new moon) the Earth casts no shadow on the Moon.
  if (u <= 0) return { distance: Infinity, umbra: 0, penumbra: 0 };
  const r =
    KM_PER_AU * Math.hypot(-u * s.x - m.x, -u * s.y - m.y, -u * s.z - m.z);
  const umbra =
    SUN_RADIUS_KM - (1 + u) * (SUN_RADIUS_KM - EARTH_SHADOW_RADIUS_KM);
  const penumbra =
    -SUN_RADIUS_KM + (1 + u) * (SUN_RADIUS_KM + EARTH_SHADOW_RADIUS_KM);
  return {
    distance: r / MOON_RADIUS_KM,
    umbra: umbra / MOON_RADIUS_KM,
    penumbra: penumbra / MOON_RADIUS_KM,
  };
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new RangeError(message);
}

export function skyBodies(time: Date, place: Place): SkyBodies {
  check(Number.isFinite(time.getTime()), "time must be a valid date");
  check(
    Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90,
    "latitude must be between -90 and 90",
  );
  check(
    Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180,
    "longitude must be between -180 and 180",
  );
  check(
    Number.isFinite(place.elevationMeters ?? 0),
    "elevation must be a finite number",
  );
  const observer = new Observer(
    place.latitude,
    place.longitude,
    place.elevationMeters ?? 0,
  );
  const sun = position(Body.Sun, time, observer);
  const moon = position(Body.Moon, time, observer);
  return {
    sun: {
      ...sun.horizontal,
      radius: apparent(SUN_RADIUS_KM, sun.equatorial.dist),
    },
    moon: {
      ...moon.horizontal,
      illuminatedFraction: Illumination(Body.Moon, time).phase_fraction,
      phaseDegrees: MoonPhase(time),
      radius: apparent(MOON_RADIUS_KM, moon.equatorial.dist),
      separation: AngleBetween(sun.equatorial.vec, moon.equatorial.vec),
      shadow: earthShadow(time),
    },
  };
}
