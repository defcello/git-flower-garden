/**
 * Every renderer this build offers, in View-menu order (ADR 0022). A fork
 * adds its renderer by importing its definition and listing it here; see
 * docs/renderers.md.
 */
import {
  gardenCanvasRenderer,
  gardenSvgRenderer,
  technicalRenderer,
} from "./classic/index.tsx";
import { pixelRenderer } from "./pixel/PixelRenderer.tsx";
import type { RendererDefinition } from "./types.ts";

export const RENDERERS: readonly RendererDefinition[] = [
  technicalRenderer,
  gardenCanvasRenderer,
  gardenSvgRenderer,
  pixelRenderer,
];

/** The renderer with this id, or undefined when this build has none. */
export function findRenderer(
  id: string | null | undefined,
): RendererDefinition | undefined {
  return RENDERERS.find((renderer) => renderer.id === id);
}
