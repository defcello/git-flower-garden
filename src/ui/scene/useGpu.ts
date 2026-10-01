/**
 * A GPU tier canvas's WebGL2 context, from start to loss (ADR 0018,
 * "Choosing a tier"). The renderer is built on mount and loads its art;
 * when the context is lost, `onLost(true)` lets Software take over while
 * the canvas stays mounted, hidden, to hear the context restored, when
 * the renderer is built again and `onLost(false)` hands back. Any failure
 * to start (no context, a shader, the art) reports `onFail(true)`, for
 * Software to draw for the rest of the visit.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

export interface GpuRenderer {
  /** The renderer's name, for diagnostics. */
  readonly renderer: string;
  /** Upload the art; drawing before it resolves shows what it can. */
  load(): Promise<void>;
  /** Release the context now (the tier was switched away). */
  dispose(): void;
  /** Wait until the GPU has finished what was drawn (the frame-time probe). */
  finish(): void;
}

/**
 * Returns a ref for the canvas, the current renderer (null while lost or
 * failed), and a version that changes whenever one is built or its art
 * arrives: time to redraw.
 * `create` and both callbacks must keep their identity (module functions
 * and state setters).
 */
export function useGpu<T extends GpuRenderer>(
  create: (element: HTMLCanvasElement) => T | null,
  onLost: (lost: boolean) => void,
  onFail: (failed: true) => void,
): {
  /** For the canvas element. */
  canvas: RefObject<HTMLCanvasElement | null>;
  renderer: RefObject<T | null>;
  version: number;
} {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<T | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let alive = true;
    const build = () => {
      try {
        const next = create(element);
        if (next === null) {
          onFail(true);
          return;
        }
        renderer.current = next;
        element.dataset.renderer = next.renderer;
        setVersion((v) => v + 1);
        next.load().then(
          () => {
            if (alive && renderer.current === next) setVersion((v) => v + 1);
          },
          () => {
            if (alive) onFail(true);
          },
        );
      } catch {
        onFail(true);
      }
    };
    const lost = (event: Event) => {
      // Without this the context is never restored.
      event.preventDefault();
      renderer.current = null;
      onLost(true);
    };
    const restored = () => {
      build();
      onLost(false);
    };
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    build();
    return () => {
      alive = false;
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
      // Free the GPU's memory now, not when the element is collected.
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [create, onLost, onFail]);

  return { canvas, renderer, version };
}
