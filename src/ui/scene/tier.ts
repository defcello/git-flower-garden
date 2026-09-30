/**
 * Choosing a drawing tier (ADR 0018, "Choosing a tier"). Pure: the browser
 * probes that feed it live in motion.ts.
 */
import { FRAME_MS } from "../sway.ts";

/** The Drawing choice in the View controls. */
export type Tier = "auto" | "gpu" | "software" | "static";
export const TIERS: readonly Tier[] = ["auto", "gpu", "software", "static"];

/** What actually draws the scene. */
export type DrawingTier = "gpu" | "software" | "static";

/**
 * What WebGL2 this browser offers: on real graphics hardware, only through
 * a software rasterizer, or not at all.
 */
export type GpuSupport = "hardware" | "software" | "none";

/**
 * Renderer names of software WebGL: Chromium's SwiftShader (which headless
 * Chromium passes off as no major performance caveat), Mesa's llvmpipe and
 * softpipe, and Windows' Basic Render Driver.
 */
const SOFTWARE_RENDERERS =
  /swiftshader|llvmpipe|softpipe|software|basic render/i;

export function isSoftwareRenderer(name: string): boolean {
  return SOFTWARE_RENDERERS.test(name);
}

/**
 * The tier that draws. Auto takes the GPU only on real hardware: software
 * WebGL is too slow for the budget, and Canvas 2D already falls back to the
 * CPU. GPU, chosen by hand, also accepts software WebGL (it is how tests
 * and curious viewers force it), and falls back to Software only without
 * WebGL2. A lost context draws with Software until it is restored. When
 * the frame-time probe finds the GPU too slow (`slow`), Auto takes
 * Software for the rest of the visit; GPU chosen by hand stays.
 */
export function resolveTier(
  choice: Tier,
  support: GpuSupport,
  lost = false,
  slow = false,
): DrawingTier {
  if (choice === "static" || choice === "software") return choice;
  if (lost) return "software";
  if (choice === "gpu") return support === "none" ? "software" : "gpu";
  return support === "hardware" && !slow ? "gpu" : "software";
}

/** What the GPU tier's probe times: each of its two canvases. */
export type GpuPart = "landscape" | "plants";

/** Frames of each part not timed: shader warm-up and first uploads. */
export const GPU_WARMUP = 2;
/** Frames of each part timed after the warm-up; then timing stops. */
export const GPU_SAMPLES = 6;
/**
 * The GPU tier's budget for a whole frame, landscape and plants, finished
 * on the GPU: half a frame at the animation cap, so it stays well ahead of
 * the frames it draws.
 */
export const GPU_BUDGET_MS = FRAME_MS / 2;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * The probe's verdict on timed GPU frames (milliseconds from the first
 * draw call to the frame finished on the GPU), or null until it has
 * enough: the plants draw every frame and must have three samples; the
 * landscape draws only when the light or size changes, so it counts with
 * however many it has. Too slow when the two medians together run past
 * the budget, since a frame while the light moves draws both.
 */
export function gpuVerdict(
  samples: Readonly<Record<GpuPart, readonly number[]>>,
): { slow: boolean; ms: number } | null {
  if (samples.plants.length < 3) return null;
  const ms =
    median(samples.plants) +
    (samples.landscape.length > 0 ? median(samples.landscape) : 0);
  return { slow: ms > GPU_BUDGET_MS, ms };
}
