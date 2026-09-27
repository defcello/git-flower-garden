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
  Body,
  Equator,
  Horizon,
  Illumination,
  MoonPhase,
  Observer,
} from "#astronomy-engine";

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
  sun: BodyPosition;
  moon: BodyPosition & {
    /** Lit fraction of the disc, 0 (new) to 1 (full). */
    illuminatedFraction: number;
    /** Moon minus Sun ecliptic longitude: 0 new, 90 first quarter, 180 full, 270 last quarter. */
    phaseDegrees: number;
  };
}

function position(body: Body, time: Date, observer: Observer): BodyPosition {
  const equatorial = Equator(body, time, observer, true, true);
  const horizontal = Horizon(
    time,
    observer,
    equatorial.ra,
    equatorial.dec,
    "normal",
  );
  return { altitude: horizontal.altitude, azimuth: horizontal.azimuth };
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
  return {
    sun: position(Body.Sun, time, observer),
    moon: {
      ...position(Body.Moon, time, observer),
      illuminatedFraction: Illumination(Body.Moon, time).phase_fraction,
      phaseDegrees: MoonPhase(time),
    },
  };
}
