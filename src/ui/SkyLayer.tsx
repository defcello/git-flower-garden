/**
 * Sun, Moon, and stars over the painted sky, placed by the lighting model's
 * panorama (east left, west right) and physical altitude. Decorative only:
 * hidden from assistive technology and never a pointer target.
 */
import { memo } from "react";
import type { LightingState } from "../environment/lighting.ts";
import { HORIZON, skyPoint } from "./sky.ts";

// A fixed star field, so stars never jump between refreshes.
const STARS = (() => {
  let seed = 20240508;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: 90 }, () => ({
    x: random() * 1000,
    // Above the far ridgeline only, never in front of the mountains.
    y: random() * HORIZON * 960,
    r: 0.6 + random() * 1.1,
    a: 0.35 + random() * 0.65,
  }));
})();

const rgb = (color: readonly number[], alpha = 1) =>
  `rgb(${color.map((c) => String(Math.round(c * 255))).join(" ")} / ${String(alpha)})`;

/** The Moon's lit shape, lit limb toward +x, for a disc of radius r. */
export function moonPath(illuminatedFraction: number, r: number): string {
  const terminator = r * (1 - 2 * illuminatedFraction);
  const sweep = terminator > 0 ? 0 : 1;
  const rx = Math.abs(terminator).toFixed(3);
  const R = String(r);
  return `M 0 ${String(-r)} A ${R} ${R} 0 0 1 0 ${R} A ${rx} ${R} 0 0 ${String(sweep)} 0 ${String(-r)} Z`;
}

const MOON_RADIUS = 14;

export const SkyLayer = memo(function SkyLayer({
  state,
}: {
  state: LightingState;
}) {
  const sun = skyPoint(state.sun);
  const moon = skyPoint(state.moon);
  const moonOpacity = state.moon.aboveHorizon
    ? 0.45 + 0.55 * (1 - state.sun.intensity)
    : 0;
  return (
    <div className="landscape-sky" data-twilight={state.twilight}>
      {state.stars > 0 && (
        <svg
          className="sky-stars"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          style={{ opacity: state.stars }}
        >
          {STARS.map((star, i) => (
            <circle
              key={i}
              cx={star.x}
              cy={star.y}
              r={star.r}
              fill="#fffbe8"
              opacity={star.a}
            />
          ))}
        </svg>
      )}
      {state.sun.altitude > -1 && (
        <div
          className="sky-sun"
          style={{
            left: `${(sun.x * 100).toFixed(2)}%`,
            top: `${(sun.y * 100).toFixed(2)}%`,
            background: `radial-gradient(circle, ${rgb(state.sun.color)} 0 30%, ${rgb(state.sun.color, 0.4)} 34%, transparent 70%)`,
          }}
        />
      )}
      {moonOpacity > 0 && (
        <svg
          className="sky-moon"
          data-limb={Math.round(state.moon.limbAngle)}
          viewBox="-16 -16 32 32"
          style={{
            left: `${(moon.x * 100).toFixed(2)}%`,
            top: `${(moon.y * 100).toFixed(2)}%`,
            opacity: moonOpacity,
          }}
        >
          <circle r={MOON_RADIUS} fill="#3d4660" opacity={0.35} />
          <path
            d={moonPath(state.moon.illuminatedFraction, MOON_RADIUS)}
            fill="#f4f1e0"
            transform={`rotate(${(-state.moon.limbAngle).toFixed(1)})`}
          />
        </svg>
      )}
    </div>
  );
});
