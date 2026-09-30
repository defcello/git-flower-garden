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
import type { LitArt } from "./scene/client.ts";
import type { Frame } from "./transition.ts";

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

export function paintBase(
  g: CanvasRenderingContext2D,
  frame: Frame,
  art: LitArt,
  paths: PathCache,
  near: Near = everywhere,
): void {
  const lit = (color: string) => art.palette[color] ?? color;
  g.fillStyle = GROUND_COLOR;
  for (const ground of frame.grounds) {
    if (!near(ground.y, 10)) continue;
    g.beginPath();
    g.ellipse(ground.x, ground.y, ground.width / 2, 5, 0, 0, Math.PI * 2);
    g.fill();
  }
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
  art: LitArt,
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
