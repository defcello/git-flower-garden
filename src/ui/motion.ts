/*
 * The garden's drawing tier and its one animation clock (ADR 0018,
 * "Choosing a tier" and "Software tier").
 *
 * Tiers: Auto (the default), GPU, Software, and Static (scene/tier.ts).
 * Auto takes the GPU tier on graphics hardware and Software otherwise.
 * Plants animate at most SOFTWARE_FPS frames a second in either: sway, and
 * the growth transitions. Static draws one lit frame per lighting change
 * and nothing between, the low-power mode. The choice is remembered per
 * browser.
 *
 * Every swaying plant listens to one shared clock, so the whole garden
 * moves in step from a single animation-frame loop. It runs only while
 * someone listens, the page is visible, motion is allowed, and the tier
 * animates. A frame-time probe turns sway off for the visit if frames
 * arrive well behind the cap (the machine or the garden is too heavy):
 * sway is the first effect to go.
 */
import { useSyncExternalStore } from "react";
import {
  GPU_SAMPLES,
  GPU_WARMUP,
  gpuVerdict,
  isSoftwareRenderer,
  resolveTier,
  TIERS,
  type GpuPart,
  type GpuSupport,
  type Tier,
} from "./scene/tier.ts";
import { FRAME_MS, PROBE_FRAMES, tooSlow } from "./sway.ts";

export { FRAME_MS, SOFTWARE_FPS } from "./sway.ts";
export { TIERS, type Tier } from "./scene/tier.ts";

const TIER_KEY = "git-flower-garden.tier";

export function loadTier(): Tier {
  try {
    const saved = window.localStorage.getItem(TIER_KEY);
    return TIERS.find((tier) => tier === saved) ?? "auto";
  } catch {
    return "auto";
  }
}

function saveTier(next: Tier): void {
  try {
    window.localStorage.setItem(TIER_KEY, next);
  } catch {
    // Storage may be unavailable (private windows); the choice lasts this visit.
  }
}

let support: GpuSupport | null = null;

/**
 * What WebGL2 this browser offers, probed once on a throwaway canvas with
 * the options the GPU tier uses. `failIfMajorPerformanceCaveat` alone is
 * not enough: headless Chromium passes SwiftShader off as hardware, so the
 * renderer's name is checked too.
 */
export function gpuSupport(): GpuSupport {
  if (support !== null) return support;
  support = "none";
  try {
    const context = (options: WebGLContextAttributes) =>
      document.createElement("canvas").getContext("webgl2", {
        powerPreference: "low-power",
        ...options,
      });
    const fast = context({ failIfMajorPerformanceCaveat: true });
    const gl = fast ?? context({});
    if (gl !== null) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name =
        info === null
          ? String(gl.getParameter(gl.RENDERER))
          : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      support =
        fast !== null && !isSoftwareRenderer(name) ? "hardware" : "software";
      document.documentElement.dataset.gpu = `${support}: ${name}`;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // No WebGL2 at all.
  }
  return support;
}

/**
 * The GPU tier's frame-time probe (ADR 0018, "Choosing a tier"). Each GPU
 * canvas times its first frames through to the GPU finishing them (the
 * wait costs a little, so only GPU_WARMUP + GPU_SAMPLES frames each), and
 * the verdict (tier.ts `gpuVerdict`) moves Auto to Software for the rest
 * of the visit if they miss the budget. The result is on the root element
 * for diagnostics: `data-gpu-probe`.
 */
const probe: Record<GpuPart, { drawn: number; samples: number[] }> = {
  landscape: { drawn: 0, samples: [] },
  plants: { drawn: 0, samples: [] },
};
let gpuSlow = false;

/** Whether this part's next frame should be timed. */
export function probingGpu(part: GpuPart): boolean {
  return !gpuSlow && probe[part].drawn < GPU_WARMUP + GPU_SAMPLES;
}

/** Report a frame of `part` drawn on the GPU; `ms` when it was timed. */
export function reportGpuFrame(part: GpuPart, ms: number): void {
  const entry = probe[part];
  entry.drawn++;
  if (entry.drawn <= GPU_WARMUP) return;
  entry.samples.push(ms);
  const verdict = gpuVerdict({
    landscape: probe.landscape.samples,
    plants: probe.plants.samples,
  });
  if (verdict === null) return;
  document.documentElement.dataset.gpuProbe = `${verdict.slow ? "slow" : "ok"}: ${verdict.ms.toFixed(1)} ms`;
  if (verdict.slow && !gpuSlow) {
    gpuSlow = true;
    for (const listener of tierListeners) listener();
  }
}

/**
 * Whether the GPU tier should draw, re-rendering when the choice or the
 * probe's verdict changes. `lost`: the caller's context is lost.
 */
export function useWantsGpu(lost = false): boolean {
  const choice = useTier();
  const slow = useSyncExternalStore(
    (onChange) => {
      tierListeners.add(onChange);
      return () => tierListeners.delete(onChange);
    },
    () => gpuSlow,
  );
  return resolveTier(choice, gpuSupport(), lost, slow) === "gpu";
}

/** Whether motion is allowed: the OS preference and the app setting. */
export function motionAllowed(): boolean {
  if (document.documentElement.classList.contains("reduce-motion"))
    return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Listener = (seconds: number | null) => void;

let tier: Tier = loadTier();
/** Sway stopped for this visit by the probe. */
let slow = false;
const listeners = new Set<Listener>();
const tierListeners = new Set<() => void>();
let timer = 0;
let raf = 0;
let last = 0;
let gaps: number[] = [];
/** Whether listeners last saw a moving (not rest) pose. */
let moving = false;

/** Whether the current tier animates at all (growth transitions too). */
export function animates(): boolean {
  return tier !== "static" && motionAllowed();
}

function swaying(): boolean {
  return animates() && !slow && !document.hidden && listeners.size > 0;
}

function publish(seconds: number | null): void {
  moving = seconds !== null;
  for (const listener of listeners) listener(seconds);
}

function frame(now: number): void {
  raf = 0;
  if (!swaying()) {
    settle();
    return;
  }
  if (last !== 0) {
    gaps.push(now - last);
    if (gaps.length > PROBE_FRAMES) gaps.shift();
    if (tooSlow(gaps)) {
      slow = true;
      document.documentElement.dataset.sway = "slow";
      settle();
      return;
    }
  }
  last = now;
  publish(now / 1000);
  schedule();
}

/**
 * Wait for the next frame with a timer, then draw at the display's next
 * refresh, rather than asking for every animation frame and skipping most:
 * the page's script then runs only for the frames that are drawn.
 */
function schedule(): void {
  // A little early, so the refresh after the timer lands on the cap.
  const delay = Math.max(0, last + FRAME_MS - 12 - performance.now());
  timer = window.setTimeout(() => {
    timer = 0;
    raf = requestAnimationFrame(frame);
  }, delay);
}

/** Stop the loop and put every sprite back at rest. */
function settle(): void {
  if (timer !== 0) clearTimeout(timer);
  if (raf !== 0) cancelAnimationFrame(raf);
  timer = 0;
  raf = 0;
  last = 0;
  gaps = [];
  if (moving) publish(null);
}

/** Start or stop the loop to match the conditions. */
function update(): void {
  if (swaying()) {
    if (timer === 0 && raf === 0) raf = requestAnimationFrame(frame);
  } else {
    settle();
  }
}

if (typeof document !== "undefined") {
  // A hidden page stops drawing; coming back restarts the probe's count,
  // since frames were not late while nobody could see them.
  document.addEventListener("visibilitychange", update);
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", update);
  new MutationObserver(update).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

/**
 * Listen to the sway clock: called with the time in seconds on every
 * drawn frame, and with `null` when sway stops and sprites should rest.
 * Returns the time to draw now (or `null`) and a function to stop.
 */
export function listenSway(listener: Listener): {
  seconds: number | null;
  stop: () => void;
} {
  listeners.add(listener);
  update();
  return {
    seconds: moving && last !== 0 ? last / 1000 : null,
    stop: () => {
      listeners.delete(listener);
      update();
    },
  };
}

export function getTier(): Tier {
  return tier;
}

export function setTier(next: Tier): void {
  if (next === tier) return;
  tier = next;
  saveTier(next);
  for (const listener of tierListeners) listener();
  update();
}

/** The chosen tier, re-rendering when it changes. */
export function useTier(): Tier {
  return useSyncExternalStore((onChange) => {
    tierListeners.add(onChange);
    return () => tierListeners.delete(onChange);
  }, getTier);
}
