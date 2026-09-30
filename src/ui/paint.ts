/*
 * Painting one plant's frame with Canvas 2D: ground shadows, stems, knots,
 * and relit sprites, in the plant's graph coordinates. Shared by the
 * per-plot canvases (focus view and card layout) and the garden's one
 * scene canvas (GardenCanvas.tsx), so both draw a plant the same way.
 */
import {
  BADGE_HEIGHT,
  CELL_SIZE,
  HALO_COLOR,
  KNOT_COLOR,
  type Badge,
  type Sprite,
} from "./botanical.ts";
import type { Frame } from "./transition.ts";

/**
 * What painting needs of the art: the relit atlases and lit colors
 * (scene/client.ts `LitArt`), or, for the GPU tier's textures, the unlit
 * atlases and no palette (the shader lights them).
 */
export interface PaintArt {
  sprites: CanvasImageSource;
  spritesMirrored: CanvasImageSource;
  /** Lit colors by their unlit value; a color not listed is drawn as is. */
  palette: Readonly<Record<string, string>>;
}

export const GROUND_COLOR = "rgba(38, 52, 24, 0.22)";

/** Whether a mark at `y`, reaching `reach` either way, is in view. */
export type Near = (y: number, reach: number) => boolean;
export const everywhere: Near = () => true;

/** Parses each path string once, not on every pan, zoom, or sway frame. */
export class PathCache {
  private paths = new Map<string, Path2D>();
  get(d: string): Path2D {
    let p = this.paths.get(d);
    if (!p) {
      // A long-lived garden sees many histories; do not grow without bound.
      if (this.paths.size > 20_000) this.paths.clear();
      p = new Path2D(d);
      this.paths.set(d, p);
    }
    return p;
  }
}

/** A ground shadow's vertical radius, in graph pixels. */
export const GROUND_RY = 5;

export function paintGrounds(
  g: CanvasRenderingContext2D,
  frame: Frame,
  near: Near = everywhere,
): void {
  g.fillStyle = GROUND_COLOR;
  for (const ground of frame.grounds) {
    if (!near(ground.y, 10)) continue;
    g.beginPath();
    g.ellipse(
      ground.x,
      ground.y,
      ground.width / 2,
      GROUND_RY,
      0,
      0,
      Math.PI * 2,
    );
    g.fill();
  }
}

/** Grounds, then stems and knots (`paintStems`). */
export function paintBase(
  g: CanvasRenderingContext2D,
  frame: Frame,
  art: PaintArt,
  paths: PathCache,
  near: Near = everywhere,
): void {
  paintGrounds(g, frame, near);
  paintStems(g, frame, art, paths, near);
}

/** Stems and their knots, in the art's lit colors. */
export function paintStems(
  g: CanvasRenderingContext2D,
  frame: Frame,
  art: PaintArt,
  paths: PathCache,
  near: Near = everywhere,
): void {
  const lit = (color: string) => art.palette[color] ?? color;
  g.lineCap = "round";
  for (const stem of frame.stems) {
    if (!near((stem.top + stem.bottom) / 2, (stem.bottom - stem.top) / 2))
      continue;
    g.globalAlpha = stem.alpha;
    if (stem.dashed) {
      // Pale under-stroke separates crossings without introducing a junction.
      g.setLineDash([]);
      g.strokeStyle = lit(HALO_COLOR);
      g.lineWidth = stem.width + 2.5;
      g.stroke(paths.get(stem.halo));
      g.setLineDash([3, 5]);
      g.strokeStyle = lit(stem.color);
      g.lineWidth = stem.width;
      g.stroke(paths.get(stem.path));
    } else {
      g.fillStyle = lit(HALO_COLOR);
      g.fill(paths.get(stem.halo));
      g.fillStyle = lit(stem.color);
      g.fill(paths.get(stem.path));
    }
  }
  g.setLineDash([]);
  g.fillStyle = lit(KNOT_COLOR);
  for (const knot of frame.knots) {
    if (!near(knot.y, knot.r)) continue;
    g.globalAlpha = knot.alpha;
    g.beginPath();
    g.arc(knot.x, knot.y, knot.r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

export function paintSprites(
  g: CanvasRenderingContext2D,
  sprites: readonly (Sprite & { alpha: number; scale: number })[],
  art: PaintArt,
  near: Near = everywhere,
): void {
  for (const sprite of sprites) {
    if (!near(sprite.y, sprite.size)) continue;
    const size = sprite.size * sprite.scale;
    g.globalAlpha = sprite.alpha;
    g.save();
    g.translate(sprite.x, sprite.y);
    g.rotate(sprite.rotate);
    // A mirrored sprite comes from the mirrored atlas, lit as mirrored.
    g.drawImage(
      sprite.flip ? art.spritesMirrored : art.sprites,
      (sprite.kind % 2) * CELL_SIZE,
      Math.floor(sprite.kind / 2) * CELL_SIZE,
      CELL_SIZE,
      CELL_SIZE,
      -size / 2,
      -size / 2,
      size,
      size,
    );
    g.restore();
  }
  g.globalAlpha = 1;
}

/** The page's colors and font for badges (styles.css .badge), which follow the theme. */
export interface BadgeStyle {
  fill: string;
  stroke: string;
  ink: string;
  font: string;
}

export function badgeStyle(element: Element): BadgeStyle {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    fill: color("--card"),
    stroke: color("--edge"),
    ink: color("--ink"),
    font: `9px ${style.fontFamily}`,
  };
}

/** Hidden-commit counts, as the technical drawing shows them (GraphSvg.tsx). */
export function paintBadges(
  g: CanvasRenderingContext2D,
  badges: readonly Badge[],
  style: BadgeStyle,
): void {
  if (badges.length === 0) return;
  g.lineWidth = 1;
  g.setLineDash([2, 2]);
  g.font = style.font;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  for (const badge of badges) {
    g.beginPath();
    g.roundRect(
      badge.x - badge.width / 2,
      badge.y - BADGE_HEIGHT / 2,
      badge.width,
      BADGE_HEIGHT,
      BADGE_HEIGHT / 2,
    );
    g.fillStyle = style.fill;
    g.fill();
    g.strokeStyle = style.stroke;
    g.stroke();
    g.fillStyle = style.ink;
    g.fillText(badge.text, badge.x, badge.y + 3.5);
  }
  g.setLineDash([]);
}

/** A drop shadow or glow, in graph pixels (scaled by `k` when cast). */
export interface Cast {
  x: number;
  y: number;
  blur: number;
  color: string;
}

/** The hover outline, as the plots' CSS had it: two tight, one soft. */
export const OUTLINE: readonly Cast[] = [
  { x: 0, y: 0, blur: 1, color: "#00e5ff" },
  { x: 0, y: 0, blur: 1, color: "#00e5ff" },
  { x: 0, y: 0, blur: 5, color: "#00e5ffcc" },
];

/** styles.css .plot.wilting, before the scene canvas drew the plants. */
export const WILTING = "saturate(0.45) brightness(0.92)";

/** Room around a plant's bounds for its shadow or outline, in graph pixels. */
export const MARGIN = 34;

/**
 * Shadows alone, from `source`'s first w×h pixels: the source is drawn
 * out of view and each shadow thrown back into place. Canvas shadows are
 * in device pixels.
 */
export function castShadows(
  g: CanvasRenderingContext2D,
  source: CanvasImageSource,
  w: number,
  h: number,
  casts: readonly Cast[],
  k: number,
): void {
  const away = w + 64;
  for (const c of casts) {
    g.shadowColor = c.color;
    g.shadowBlur = c.blur * k;
    g.shadowOffsetX = c.x * k + away;
    g.shadowOffsetY = c.y * k;
    g.drawImage(source, 0, 0, w, h, -away, 0, w, h);
  }
  g.shadowColor = "transparent";
  g.shadowBlur = 0;
  g.shadowOffsetX = 0;
  g.shadowOffsetY = 0;
}

/** Whether this browser's canvases take CSS filters (Safari before 18 does not). */
export function canvasFilters(g: CanvasRenderingContext2D): boolean {
  return typeof (g as { filter?: unknown }).filter === "string";
}

/**
 * Size a stage canvas's backing store to the element at the device pixel
 * ratio, capped at 2 (ADR 0018, "Resolution"). Resizing clears it, so it
 * is left alone when the size holds.
 */
export function fitCanvas(element: HTMLCanvasElement): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(element.clientWidth * ratio));
  const H = Math.max(1, Math.round(element.clientHeight * ratio));
  if (element.width !== W || element.height !== H) {
    element.width = W;
    element.height = H;
  }
}
