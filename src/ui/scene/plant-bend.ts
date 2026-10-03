/*
 * Plants bend in the wind as the grass does (ADR 0021): each plant is posed
 * as a tuft growing from its base (grass.ts tuftPose), at STEM_GIVE of the
 * grass's angle, since its stems are stiffer, and its stems, sprites, and
 * badges curve along that arc, the top most. Only the art moves: at rest
 * (no sway) a plant stands exactly as the graph puts it, and its hit
 * targets never move. Pure, for tests; the tiers draw it (GardenCanvas.tsx,
 * plants-gpu.ts).
 */
import { seeded } from "../botanical.ts";
import { groundLine, toDesign, type PlantDescription } from "./description.ts";
import { tuftPose, VIEW_TILT, type PoseFrame, type Tuft } from "./grass.ts";

/** How far a plant bends, relative to the grass beside it. */
export const STEM_GIVE = 0.5;

/**
 * How far a plant's bend wanders about the wind's heading, radians (about
 * 6°): gusts buffet a bush a little sideways as well as along, so a wind
 * straight into the scene sways it gently too.
 */
export const BUFFET = 0.1125;

/** Rows a plant's stems are drawn in when bent: enough to curve smoothly. */
export const STEM_ROWS = 16;

/** A plant's bend in one frame, in design pixels. */
export interface PlantBend {
  /** Radians at the top, toward `heading`. */
  bend: number;
  /** Where the wind blows (windHeading): x right, z into the scene. */
  heading: { x: number; z: number };
  /** Its base line, and its height above it. */
  baseY: number;
  height: number;
}

/** The plant's bend at `seconds` (null at rest: no bend at all). */
export function plantBend(
  plant: PlantDescription,
  seconds: number | null,
  frame: PoseFrame,
): PlantBend | null {
  if (seconds === null || plant.highlighted || plant.wilting) return null;
  const baseY = groundLine(plant);
  const height = baseY - toDesign(plant, 0, plant.bounds.y).y;
  if (height <= 0) return null;
  const seed = seeded(`${plant.id}|bend`);
  const tuft: Tuft = {
    x: plant.x,
    y: baseY,
    size: height,
    kind: 0,
    flip: false,
    seed,
    stretch: 1,
    stiff: 1,
    // A plant is heavier than a tuft: it answers the gusts later.
    delay: 0.15 + 0.15 * seed,
  };
  const { bend } = tuftPose(tuft, seconds, frame.wind, frame);
  const wander =
    BUFFET *
    Math.sin((2 * Math.PI * seconds) / (3.7 + 1.5 * seed) + 2 * Math.PI * seed);
  const { x, z } = frame.heading;
  const c = Math.cos(wander);
  const s = Math.sin(wander);
  return {
    bend: STEM_GIVE * bend,
    heading: { x: x * c - z * s, z: x * s + z * c },
    baseY,
    height,
  };
}

/**
 * Where a point of the plant `v` design pixels above its base goes when
 * bent: as grass.ts tuftBend's, every point of a row moves as the stems'
 * arc does there, so stems keep their length, upright or across (rows are
 * not turned about one spine, which would stretch the stems beside it).
 * Bent across the view, the top swings out and drops; into the scene or
 * toward the viewer, it sinks (VIEW_TILT), the same either way. Returns the
 * move on screen (design pixels: x right, y down) and how far the stems
 * there lean on screen (radians, + clockwise, as sprites rotate).
 */
export function bendAt(
  bend: PlantBend,
  v: number,
): { dx: number; dy: number; turn: number } {
  const h = Math.max(0, Math.min(bend.height, v));
  const phi = (bend.bend * h) / bend.height;
  const small = Math.abs(phi) < 1e-4;
  const along = small ? (h * phi) / 2 : (h * (1 - Math.cos(phi))) / phi;
  const rise = small ? h : (h * Math.sin(phi)) / phi;
  const { x, z } = bend.heading;
  // Into the scene or toward the viewer, the top sinks as the stems tip:
  // drawn flat, a plant shows either lean by foreshortening. (The view's
  // tilt, as grass.ts tuftBend has it, would lift a lean away by about
  // what its arc loses, so a wind into the scene would hardly show.)
  const up = rise - VIEW_TILT * Math.abs(z) * along;
  // The stems' direction there, on screen.
  const lean = Math.atan2(
    x * Math.sin(phi),
    Math.cos(phi) - VIEW_TILT * Math.abs(z) * Math.sin(phi),
  );
  return { dx: x * along, dy: h - up, turn: lean };
}

/** Sprites (graph coordinates) moved and turned with their plant's bend. */
export function bendSprites<T extends { x: number; y: number; rotate: number }>(
  sprites: readonly T[],
  plant: PlantDescription,
  bend: PlantBend | null,
): readonly T[] {
  if (bend === null) return sprites;
  return sprites.map((sprite) => {
    const at = toDesign(plant, sprite.x, sprite.y);
    const { dx, dy, turn } = bendAt(bend, bend.baseY - at.y);
    return {
      ...sprite,
      x: sprite.x + dx / plant.scale,
      y: sprite.y + dy / plant.scale,
      rotate: sprite.rotate + turn,
    };
  });
}

/** The farthest any part of a bent plant moves sideways, design pixels. */
export function bendReach(bend: PlantBend | null): number {
  return bend === null ? 0 : Math.abs(bendAt(bend, bend.height).dx);
}
