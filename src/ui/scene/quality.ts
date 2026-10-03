/*
 * Quality presets (ADR 0018 step 6, roadmap P2-E). Pure: the setting lives
 * in motion.ts. A preset sets how often the garden animates, how sharply
 * its canvases are drawn, how much rain and snow fall, and whether plants
 * sway. The Drawing choice (tier.ts) is separate: Static still stops all
 * motion, whatever the preset.
 */

/** The Quality choice in the View controls. */
export type Quality = "low" | "balanced" | "high";
export const QUALITIES: readonly Quality[] = ["low", "balanced", "high"];

/**
 * High by default (maintainer decision, 2026-10-01): most devices keep up,
 * and those that cannot step down on their own (motion.ts).
 */
export const DEFAULT_QUALITY: Quality = "high";

export interface Preset {
  /** Animation frames a second: sway, rain and snow, growth. */
  fps: number;
  /** The most device pixels per CSS pixel the garden's canvases use. */
  pixelRatio: number;
  /** Particles, as a share of each tier's caps (PARTICLE_CAPS). */
  particles: { gpu: number; software: number };
  /** Whether plants sway; rain and snow fall either way. */
  sway: boolean;
  /**
   * Grass tufts, as a density of the full field (scene/grass.ts). The same
   * on both tiers: falling back to Software never changes the meadow.
   */
  grass: number;
}

/**
 * Balanced is the garden as it was before presets: 15 fps, a pixel ratio of
 * 2, the measured particle caps. Low quarters the pixels of a high-density
 * display and halves the particles, and only the weather and the light
 * move. High doubles the rate and, on the GPU, adds half again the rain
 * and snow; Software keeps its caps.
 */
export const PRESETS: Readonly<Record<Quality, Preset>> = {
  low: {
    fps: 10,
    pixelRatio: 1,
    particles: { gpu: 0.5, software: 0.5 },
    sway: false,
    grass: 0.5,
  },
  balanced: {
    fps: 15,
    pixelRatio: 2,
    particles: { gpu: 1, software: 1 },
    sway: true,
    grass: 0.75,
  },
  high: {
    fps: 30,
    pixelRatio: 2,
    particles: { gpu: 1.5, software: 1 },
    sway: true,
    grass: 0.75,
  },
};
