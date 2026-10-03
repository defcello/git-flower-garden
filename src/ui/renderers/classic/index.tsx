import { plantShadowStyle } from "../../scene/view.ts";
import type { RendererDefinition } from "../types.ts";
import {
  ClassicRenderer,
  GardenControls,
  GardenKey,
  Legend,
} from "./ClassicRenderer.tsx";

/** The commit graph without artwork: the visual-truth reference. */
export const technicalRenderer: RendererDefinition = {
  id: "technical",
  label: "Technical",
  description:
    "Commit graphs with branch names, tags, and messages; no artwork.",
  usesEnvironment: false,
  ownsFocusDetails: true,
  layout: "page",
  Component: ClassicRenderer,
  Controls: Legend,
};

const garden = {
  usesEnvironment: true,
  ownsFocusDetails: true,
  layout: "scene",
  Controls: GardenControls,
  Key: GardenKey,
  rootStyle: (environment) => plantShadowStyle(environment.shownLight),
} satisfies Partial<RendererDefinition>;

/** The relit hillside garden, its plants drawn into one scene canvas. */
export const gardenCanvasRenderer: RendererDefinition = {
  ...garden,
  id: "canvas",
  label: "Garden preview · Canvas",
  description: "Flowering plants on a relit Blue Ridge hillside (Canvas).",
  Component: ClassicRenderer,
};

/** The same garden with each plant drawn as SVG over the scene. */
export const gardenSvgRenderer: RendererDefinition = {
  ...garden,
  id: "svg",
  label: "Garden preview · SVG",
  description: "Flowering plants on a relit Blue Ridge hillside (SVG).",
  Component: ClassicRenderer,
};
