/**
 * Choosing a drawing tier (ADR 0018, "Choosing a tier"). Pure: the browser
 * probe that feeds it lives in motion.ts.
 */

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
 * WebGL2. A lost context draws with Software until it is restored.
 */
export function resolveTier(
  choice: Tier,
  support: GpuSupport,
  lost = false,
): DrawingTier {
  if (choice === "static" || choice === "software") return choice;
  if (lost) return "software";
  if (choice === "gpu") return support === "none" ? "software" : "gpu";
  return support === "hardware" ? "gpu" : "software";
}
