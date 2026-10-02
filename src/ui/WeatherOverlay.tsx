/**
 * Rain, sleet, snow, and fog over the hillside (ADR 0018 step 5): in front
 * of the plants, behind every icon, card, and label, and never a pointer
 * target. The GPU tier draws instanced particles (scene/precipitation-gpu.ts),
 * Software draws fewer with Canvas 2D; both place them with `particleAt`.
 *
 * Particles move on the garden's one animation clock (motion.ts), so they
 * share its frame cap, stop while the page is hidden, and stop when the
 * probe finds the machine too slow. Static, reduced motion, or a stopped
 * clock show one still frame: the rain is still there, it just does not
 * fall. Fog is a still band of haze.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { LightingState } from "../environment/lighting.ts";
import {
  particleAt,
  particleField,
  type ParticleField,
  type WeatherEffects,
} from "../environment/weather-effects.ts";
import { listenFall, preset, useQuality, useWantsGpu } from "./motion.ts";
import { fitCanvas } from "./paint.ts";
import { PrecipitationGpu } from "./scene/precipitation-gpu.ts";
import { useGpu } from "./scene/useGpu.ts";
import { toCanvas, transform } from "./scene/view.ts";

/** The instant a still frame shows. */
const STILL = 0;

/**
 * Call `draw` with the clock's time on every frame, the still time when it
 * stops, and again on resize and when the page is shown.
 */
function useFall(
  active: boolean,
  draw: (seconds: number) => void,
  deps: readonly unknown[],
): void {
  // A new preset may change the canvas's resolution.
  const quality = useQuality();
  useEffect(() => {
    if (!active) return;
    let seconds = STILL;
    const paint = (next: number | null) => {
      seconds = next ?? STILL;
      if (!document.hidden) draw(seconds);
    };
    const clock = listenFall(paint);
    paint(clock.seconds);
    const again = () => {
      paint(seconds);
    };
    window.addEventListener("resize", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      clock.stop();
      window.removeEventListener("resize", again);
      document.removeEventListener("visibilitychange", again);
    };
    // `draw` is rebuilt with its inputs, which are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, quality, ...deps]);
}

const rgba = (field: ParticleField) =>
  `rgb(${field.color.map((v) => String(Math.round(v * 255))).join(" ")} / ${field.alpha.toFixed(3)})`;

function SoftwareFall({ field }: { field: ParticleField | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useFall(
    true,
    (seconds) => {
      const element = canvas.current;
      const g = element?.getContext("2d");
      if (!element || !g) return;
      fitCanvas(element, preset().pixelRatio);
      g.clearRect(0, 0, element.width, element.height);
      if (field === null) return;
      const t = transform(element.width, element.height);
      g.beginPath();
      if (field.type === "rain") {
        // One path of streaks along the fall, one stroke.
        const length = Math.hypot(field.slant, 1);
        const dx = ((field.slant / length) * field.size) / 2;
        const dy = field.size / length / 2;
        for (let i = 0; i < field.count; i++) {
          const p = particleAt(field, i, seconds);
          const a = toCanvas(t, p.x - dx, p.y - dy);
          const b = toCanvas(t, p.x + dx, p.y + dy);
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.lineWidth = Math.max(1, 1.5 * t.scale);
        g.lineCap = "round";
        g.strokeStyle = rgba(field);
        g.stroke();
      } else {
        const r = field.size * t.scale;
        for (let i = 0; i < field.count; i++) {
          const p = particleAt(field, i, seconds);
          const c = toCanvas(t, p.x, p.y);
          g.moveTo(c.x + r, c.y);
          g.arc(c.x, c.y, r, 0, Math.PI * 2);
        }
        g.fillStyle = rgba(field);
        g.fill();
      }
    },
    [field],
  );
  return (
    <canvas
      ref={canvas}
      className="weather-fall"
      data-tier="software"
      data-particles={field?.count ?? 0}
    />
  );
}

function GpuFall({
  field,
  hidden,
  onLost,
  onFail,
}: {
  field: ParticleField | null;
  hidden: boolean;
  onLost: (lost: boolean) => void;
  onFail: (failed: true) => void;
}) {
  const { canvas, renderer, version } = useGpu(
    PrecipitationGpu.create,
    onLost,
    onFail,
  );
  useFall(
    !hidden,
    (seconds) => {
      const element = canvas.current;
      const gpu = renderer.current;
      if (!element || gpu === null) return;
      fitCanvas(element, preset().pixelRatio);
      gpu.draw(field, seconds);
    },
    [field, version, canvas, renderer],
  );
  return (
    <canvas
      ref={canvas}
      className="weather-fall"
      hidden={hidden}
      data-tier="gpu"
      data-particles={field?.count ?? 0}
    />
  );
}

export function WeatherOverlay({
  light,
  effects,
}: {
  light: LightingState;
  effects: WeatherEffects;
}) {
  const [lost, setLost] = useState(false);
  const [failed, setFailed] = useState(false);
  const wantsGpu = useWantsGpu() && !failed;
  const gpu = wantsGpu && !lost;
  const quality = useQuality();
  const field = useMemo(() => {
    const tier = gpu ? "gpu" : "software";
    return particleField(light, effects, tier, preset().particles[tier]);
    // `preset()` follows `quality`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [light, effects, gpu, quality]);
  if (effects.precipitation === null && effects.fog === 0) return null;
  // Fog takes the color of the light it scatters.
  const haze = light.ambient
    .map((v) => String(Math.round(Math.min(1, v * 0.9 + 0.1) * 255)))
    .join(" ");
  return (
    <div
      className="weather-overlay"
      aria-hidden="true"
      data-precipitation={effects.precipitation?.type ?? "none"}
    >
      {effects.fog > 0 && (
        <div
          className="weather-fog"
          style={{
            background: `linear-gradient(to bottom, rgb(${haze} / 0) 30%, rgb(${haze} / ${(0.45 * effects.fog).toFixed(2)}) 62%, rgb(${haze} / ${(0.3 * effects.fog).toFixed(2)}) 100%)`,
          }}
        />
      )}
      {effects.precipitation !== null && wantsGpu && (
        <GpuFall
          field={gpu ? field : null}
          hidden={lost}
          onLost={setLost}
          onFail={setFailed}
        />
      )}
      {effects.precipitation !== null && !gpu && <SoftwareFall field={field} />}
    </div>
  );
}
