/*
 * The garden's drawing tier and its one animation clock (ADR 0018,
 * "Choosing a tier" and "Software tier").
 *
 * Tiers: Auto (the default), GPU, Software, and Static (scene/tier.ts).
 * Auto takes the GPU tier on graphics hardware and Software otherwise.
 * Static draws one lit frame per lighting change and nothing between, the
 * low-power mode. The quality preset (scene/quality.ts) sets the frame
 * rate in the other tiers, for sway, rain and snow, and growth, and
 * whether plants sway at all. Both choices are remembered per browser.
 *
 * Every swaying plant, and the rain and snow, listen to one shared clock,
 * so the whole garden moves in step from a single animation-frame loop.
 * It runs only while someone listens, the page is visible, motion is
 * allowed, and the tier animates. A frame-time probe watches the gaps
 * between frames, and the time spent drawing them: if a preset faster
 * than Balanced runs well behind, or its drawing takes more than half of
 * each frame, the clock falls back to Balanced's rate for the visit; if
 * frames still run behind, the clock stops for the visit (the machine or
 * the garden is too heavy).
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
import {
  DEFAULT_QUALITY,
  PRESETS,
  QUALITIES,
  type Preset,
  type Quality,
} from "./scene/quality.ts";
import { FRAME_MS, PROBE_FRAMES, tooBusy, tooSlow } from "./sway.ts";

export { TIERS, type Tier } from "./scene/tier.ts";
export { QUALITIES, type Quality } from "./scene/quality.ts";

const TIER_KEY = "git-flower-garden.tier";
const QUALITY_KEY = "git-flower-garden.quality";

export function loadTier(): Tier {
  try {
    const saved = window.localStorage.getItem(TIER_KEY);
    return TIERS.find((tier) => tier === saved) ?? "auto";
  } catch {
    return "auto";
  }
}

function loadQuality(): Quality {
  try {
    const saved = window.localStorage.getItem(QUALITY_KEY);
    return QUALITIES.find((quality) => quality === saved) ?? DEFAULT_QUALITY;
  } catch {
    return DEFAULT_QUALITY;
  }
}

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
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
let quality: Quality = loadQuality();
/** The clock fell back to Balanced's rate for this visit (the probe). */
let stepped = false;
/** The clock stopped for this visit by the probe. */
let slow = false;
/** Swaying plants, which hear the clock only while the preset sways. */
const swayers = new Set<Listener>();
/** Rain and snow, which hear it whenever it runs. */
const fallers = new Set<Listener>();
const tierListeners = new Set<() => void>();
/** Hear when the reason motion is held (motionHold) may have changed. */
const holdListeners = new Set<() => void>();
const qualityListeners = new Set<() => void>();
let timer = 0;
let raf = 0;
let last = 0;
let gaps: number[] = [];
/** Script time of recent frames, for stepping down a fast preset. */
let works: number[] = [];
/** Whether each set last saw a moving (not rest) pose. */
let swayMoving = false;
let fallMoving = false;

/** The active quality preset. */
export function preset(): Preset {
  return PRESETS[quality];
}

/**
 * Milliseconds between animation frames: the preset's, or Balanced's once
 * the probe has stepped down.
 */
export function frameMs(): number {
  const ms = 1000 / preset().fps;
  return stepped ? Math.max(ms, FRAME_MS) : ms;
}

/** Whether the current tier animates at all (growth transitions too). */
export function animates(): boolean {
  return tier !== "static" && motionAllowed();
}

function sways(): boolean {
  return preset().sway && swayers.size > 0;
}

function running(): boolean {
  return (
    animates() && !slow && !document.hidden && (sways() || fallers.size > 0)
  );
}

function publish(seconds: number | null): void {
  const sway = sways() ? seconds : null;
  if (sway !== null || swayMoving) {
    swayMoving = sway !== null;
    for (const listener of swayers) listener(sway);
  }
  fallMoving = seconds !== null;
  for (const listener of fallers) listener(seconds);
}

function frame(now: number): void {
  raf = 0;
  if (!running()) {
    settle();
    return;
  }
  if (last !== 0) {
    gaps.push(now - last);
    if (gaps.length > PROBE_FRAMES) gaps.shift();
    const busy = frameMs() < FRAME_MS && tooBusy(works, frameMs());
    if (busy || tooSlow(gaps, frameMs())) {
      gaps = [];
      works = [];
      if (frameMs() < FRAME_MS) {
        stepped = true;
        document.documentElement.dataset.sway = "stepped";
        for (const listener of holdListeners) listener();
      } else {
        slow = true;
        document.documentElement.dataset.sway = "slow";
        for (const listener of holdListeners) listener();
        settle();
        return;
      }
    }
  }
  last = now;
  publish(now / 1000);
  if (frameMs() < FRAME_MS) {
    works.push(performance.now() - now);
    if (works.length > PROBE_FRAMES) works.shift();
  }
  schedule();
}

/**
 * Wait for the next frame with a timer, then draw at the display's next
 * refresh, rather than asking for every animation frame and skipping most:
 * the page's script then runs only for the frames that are drawn.
 */
function schedule(): void {
  // A little early, so the refresh after the timer lands on the cap.
  const delay = Math.max(0, last + frameMs() - 12 - performance.now());
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
  works = [];
  if (swayMoving || fallMoving) publish(null);
}

/** Start or stop the loop to match the conditions. */
function update(): void {
  if (running()) {
    // Plants put back at rest when the preset stops their sway.
    if (swayMoving && !sways()) {
      swayMoving = false;
      for (const listener of swayers) listener(null);
    }
    if (timer === 0 && raf === 0) raf = requestAnimationFrame(frame);
  } else {
    settle();
  }
  for (const listener of holdListeners) listener();
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

function listen(
  set: Set<Listener>,
  listener: Listener,
  moving: () => boolean,
): { seconds: number | null; stop: () => void } {
  set.add(listener);
  update();
  return {
    seconds: moving() && last !== 0 ? last / 1000 : null,
    stop: () => {
      set.delete(listener);
      update();
    },
  };
}

/**
 * Listen to the sway clock: called with the time in seconds on every
 * drawn frame, and with `null` when sway stops and sprites should rest
 * (also when the preset does not sway). Returns the time to draw now (or
 * `null`) and a function to stop.
 */
export function listenSway(listener: Listener): {
  seconds: number | null;
  stop: () => void;
} {
  return listen(swayers, listener, () => swayMoving);
}

/**
 * Listen to the same clock for rain and snow, which fall whether or not
 * the preset sways: `null` when the clock stops.
 */
export function listenFall(listener: Listener): {
  seconds: number | null;
  stop: () => void;
} {
  return listen(fallers, listener, () => fallMoving);
}

export function getTier(): Tier {
  return tier;
}

export function setTier(next: Tier): void {
  if (next === tier) return;
  tier = next;
  save(TIER_KEY, next);
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

export function getQuality(): Quality {
  return quality;
}

export function setQuality(next: Quality): void {
  if (next === quality) return;
  quality = next;
  save(QUALITY_KEY, next);
  // A new preset gets a fresh look from the probe.
  stepped = false;
  slow = false;
  gaps = [];
  works = [];
  delete document.documentElement.dataset.sway;
  for (const listener of qualityListeners) listener();
  update();
}

/** The chosen quality preset, re-rendering when it changes. */
export function useQuality(): Quality {
  return useSyncExternalStore((onChange) => {
    qualityListeners.add(onChange);
    return () => qualityListeners.delete(onChange);
  }, getQuality);
}

/**
 * Why the garden holds still when it would sway, for the view's note:
 * the device asks for reduced motion (or the configuration does), or the
 * probe stepped the preset down to 15 fps or stopped sway for this visit
 * because frames ran late. Null when it moves as chosen, and for choices
 * the viewer made (Static, Low).
 */
export type MotionHold = "reduced" | "stopped" | "stepped" | null;

export function motionHold(): MotionHold {
  if (tier === "static" || !preset().sway) return null;
  if (!motionAllowed()) return "reduced";
  if (slow) return "stopped";
  if (stepped) return "stepped";
  return null;
}

/** `motionHold`, re-rendering when it changes. */
export function useMotionHold(): MotionHold {
  return useSyncExternalStore((onChange) => {
    holdListeners.add(onChange);
    return () => holdListeners.delete(onChange);
  }, motionHold);
}
