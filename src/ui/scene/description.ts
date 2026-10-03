/*
 * The garden as one scene (ADR 0018, "One scene, two drawing tiers"): the
 * backdrop layers and every hillside plant, back to front, placed in the
 * 1920×1080 design space. Each plant keeps its botanical scene (stems,
 * knots, sprites, grounds) in its own graph coordinates, with the affine
 * placement that puts it on its slot, so a tier draws it as it would in a
 * plot (paint.ts) or as instanced sprites (the GPU tier, step 4) under one
 * transform. Interaction state that changes the art (the highlighted
 * plant, wilting) is part of the description; hit targets are not: they
 * stay in each plot's SVG overlay (ADR 0005, 0015, 0017).
 *
 * Pure and stable: the same inputs give an equal description, and each
 * graph's botanical scene is computed once and shared by identity.
 */
import type { GraphJson } from "../../api/types.ts";
import { botanicalScene, type Scene } from "../botanical.ts";
import type { HillsideSlot } from "../hillside.ts";
import { MAX_SWAY } from "../sway.ts";
import { DESIGN } from "./view.ts";

/** Backdrop layers, back to front, each covering the design space. */
export const LAYERS = ["ridge", "hill"] as const;
export type LayerName = (typeof LAYERS)[number];

export interface PlantInput {
  /** The repository id. */
  id: string;
  graph: GraphJson;
  slot: HillsideSlot;
  /** Stale or incomplete: drawn desaturated (styles.css .plot.wilting). */
  wilting: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlantDescription {
  id: string;
  /** The plant's botanical scene, in graph coordinates. */
  scene: Scene;
  /**
   * Placement: a graph point (gx, gy) is drawn at design point
   * (x + (gx - anchorX) * scale, y + (gy - anchorY) * scale). The anchor
   * is the base of the plant's lanes, which stands on the slot.
   */
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  /** What the art can cover, swaying included, in graph coordinates. */
  bounds: Box;
  wilting: boolean;
  /** Hovered or keyboard-focused: outlined and drawn in front of all. */
  highlighted: boolean;
}

export interface SceneDescription {
  width: number;
  height: number;
  layers: readonly LayerName[];
  /** Back to front: back rows first, the highlighted plant last. */
  plants: PlantDescription[];
}

const scenes = new WeakMap<GraphJson, Scene>();

/** A graph's botanical scene, computed once per graph object. */
export function sceneOf(graph: GraphJson): Scene {
  let scene = scenes.get(graph);
  if (!scene) {
    scene = botanicalScene(graph);
    scenes.set(graph, scene);
  }
  return scene;
}

/**
 * Where a scene's art can reach: its lanes and rows, and every sprite at
 * any sway angle (a sprite turns about the bottom of its cell, so its far
 * corner can reach about 1.2 sizes from its center).
 */
export function sceneBounds(scene: Scene, graph: GraphJson): Box {
  let left = 0;
  let top = 0;
  let right = graph.size.width;
  let bottom = graph.size.height;
  const reach = (x: number, y: number, r: number) => {
    left = Math.min(left, x - r);
    right = Math.max(right, x + r);
    top = Math.min(top, y - r);
    bottom = Math.max(bottom, y + r);
  };
  for (const sprite of scene.sprites)
    reach(sprite.x, sprite.y, sprite.size * (0.71 + 1.12 * MAX_SWAY) + 1);
  for (const knot of scene.knots) reach(knot.x, knot.y, knot.r);
  for (const ground of scene.grounds)
    reach(ground.x, ground.y, ground.width / 2);
  for (const badge of scene.badges)
    reach(badge.x, badge.y, Math.max(badge.width / 2, 7) + 1);
  for (const stem of scene.stems) {
    top = Math.min(top, stem.top - stem.width);
    bottom = Math.max(bottom, stem.bottom + stem.width);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A graph point of a plant, in design pixels. */
export function toDesign(
  plant: PlantDescription,
  gx: number,
  gy: number,
): { x: number; y: number } {
  return {
    x: plant.x + (gx - plant.anchorX) * plant.scale,
    y: plant.y + (gy - plant.anchorY) * plant.scale,
  };
}

/**
 * Where a plant meets the ground, as a design-pixel height: its lowest
 * ground shadow (botanical.ts), or its anchor if it has none. Its cast
 * shadow starts here.
 */
export function groundLine(plant: PlantDescription): number {
  const grounds = plant.scene.grounds;
  const gy =
    grounds.length > 0
      ? Math.max(...grounds.map((ground) => ground.y))
      : plant.anchorY;
  return toDesign(plant, 0, gy).y;
}

/**
 * The garden scene for these plants. `highlighted` is the id of the plant
 * under the pointer or keyboard focus, if any.
 */
export function gardenScene(
  plants: readonly PlantInput[],
  highlighted: string | null,
): SceneDescription {
  const described = plants.map((plant, order) => {
    const scene = sceneOf(plant.graph);
    return {
      order,
      // As the plots stack (App.tsx --plant-z): by slot row.
      depth: Math.round(plant.slot.y * 10),
      plant: {
        id: plant.id,
        scene,
        x: (plant.slot.x / 100) * DESIGN.width,
        y: (plant.slot.y / 100) * DESIGN.height,
        anchorX: plant.graph.size.width / 2,
        anchorY: plant.graph.size.height,
        scale: plant.slot.scale,
        bounds: sceneBounds(scene, plant.graph),
        wilting: plant.wilting,
        highlighted: plant.id === highlighted,
      } satisfies PlantDescription,
    };
  });
  // Back rows first, then configuration order; the highlighted plant
  // rises above every other.
  const depth = (d: (typeof described)[number]) =>
    d.plant.highlighted ? Infinity : d.depth;
  described.sort((a, b) => depth(a) - depth(b) || a.order - b.order);
  return {
    width: DESIGN.width,
    height: DESIGN.height,
    layers: LAYERS,
    plants: described.map((d) => d.plant),
  };
}
