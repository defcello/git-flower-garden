/*
 * The garden's drawing tier and its one animation clock (ADR 0018,
 * "Choosing a tier" and "Software tier").
 *
 * Tiers: Auto (the default), Software, and Static; the GPU tier arrives in
 * step 4, until then Auto means Software. Software animates at most
 * SOFTWARE_FPS frames a second: sway, and the growth transitions. Static
 * draws one lit frame per lighting change and nothing between, the
 * low-power mode. The choice is remembered per browser.
 *
 * Every swaying plant listens to one shared clock, so the whole garden
 * moves in step from a single animation-frame loop. It runs only while
 * someone listens, the page is visible, motion is allowed, and the tier
 * animates. A frame-time probe turns sway off for the visit if frames
 * arrive well behind the cap (the machine or the garden is too heavy):
 * sway is the first effect to go.
 */
import { useSyncExternalStore } from "react";
import { FRAME_MS, PROBE_FRAMES, tooSlow } from "./sway.ts";

export { FRAME_MS, SOFTWARE_FPS } from "./sway.ts";

export type Tier = "auto" | "software" | "static";
export const TIERS: readonly Tier[] = ["auto", "software", "static"];

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
