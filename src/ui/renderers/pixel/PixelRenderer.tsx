/**
 * A small pixel-art garden (ADR 0022), and the template for new renderers:
 * pixel-art.ts turns the view models into a frame, and this component only
 * shows it and maps pointer and keyboard input back to commits. The shell
 * supplies the details panel and tooltip.
 */
import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import type { RendererDefinition, RendererProps } from "../types.ts";
import { featuredCommit, FRAME, nodeAt, pixelFrame } from "./pixel-art.ts";

function PixelRenderer({
  garden,
  environment,
  onSelect,
  onHover,
}: RendererProps) {
  const frame = useMemo(
    () => pixelFrame(garden, environment),
    [garden, environment],
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(frame.pixels),
        frame.width,
        frame.height,
      ),
      0,
      0,
    );
  }, [frame]);

  const stage = useRef<HTMLDivElement>(null);
  /** The art pixel under the pointer. */
  const artPoint = (event: { clientX: number; clientY: number }) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: -1, y: -1 };
    return {
      x: ((event.clientX - box.left) / box.width) * frame.width,
      y: ((event.clientY - box.top) / box.height) * frame.height,
    };
  };

  const pct = (value: number, of: number) => `${String((value / of) * 100)}%`;
  return (
    <main className="pixel-garden" aria-label="All repositories">
      <div
        ref={stage}
        className="pixel-stage"
        onPointerMove={(event) => {
          const { x, y } = artPoint(event);
          const hit = nodeAt(frame, x, y);
          onHover(hit?.node ?? null, hit ? event : undefined);
        }}
        onPointerLeave={() => {
          onHover(null);
        }}
      >
        <canvas
          ref={canvas}
          width={FRAME.width}
          height={FRAME.height}
          aria-hidden="true"
        />
        {frame.plants.map((plant) => {
          const { box, repo } = plant;
          const featured = featuredCommit(plant);
          const style: CSSProperties = {
            left: pct(box.x0, frame.width),
            top: pct(box.y0, frame.height),
            width: pct(box.x1 - box.x0 + 1, frame.width),
            height: pct(box.y1 - box.y0 + 1, frame.height),
          };
          return (
            <button
              key={repo.id}
              type="button"
              className="pixel-plant"
              data-plot={repo.id}
              data-state={repo.health.state}
              style={style}
              aria-label={`${repo.label}: ${repo.health.word}${featured ? `, newest ${featured.subject}` : ""}`}
              title={repo.label}
              onClick={(event) => {
                // A keyboard press has no pointer: open the featured commit.
                const { x, y } =
                  event.detail === 0 ? { x: -1, y: -1 } : artPoint(event);
                const hit = nodeAt(frame, x, y);
                const node = hit?.plant === plant ? hit.node : featured;
                if (node) onSelect({ repoId: repo.id, oid: node.oid });
              }}
            >
              {repo.health.marker !== null && (
                <span className="pixel-marker" aria-hidden="true">
                  {repo.health.marker}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </main>
  );
}

function PixelKey() {
  return (
    <span className="art-key">
      Pixel garden: flowers = branch heads · leaves = commits · red fruit = tags
      · dark knots = common ancestors. Grey plants show a last-known state; a
      stake marks a repository that needs attention.
    </span>
  );
}

export const pixelRenderer: RendererDefinition = {
  id: "pixel",
  label: "Pixel art",
  description:
    "A low-resolution pixel garden under the same sky: a template for new renderers.",
  usesEnvironment: true,
  layout: "scene",
  Component: PixelRenderer,
  Key: PixelKey,
};
