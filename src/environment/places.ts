/**
 * Named places for the sky. Imports no astronomy, so the server's
 * configuration can use them: the release package does not carry the
 * `#astronomy-engine` import, which only the UI bundle resolves.
 */
import type { Place } from "./astronomy.ts";

/**
 * The sky's place when none is configured: Blacksburg, Virginia, in the
 * Blue Ridge (maintainer choice, 2026-09-28).
 */
export const BLACKSBURG: Place = {
  latitude: 37.2296,
  longitude: -80.4139,
  elevationMeters: 634,
};
export const BLACKSBURG_ZONE = "America/New_York";
