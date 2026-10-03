/**
 * The renderer contract (ADR 0022). A renderer is a View: it draws the
 * garden's view models however it likes (SVG, Canvas 2D, WebGL, pixel art,
 * video) and reports what the viewer points at back to the shell. It never
 * fetches data or keeps its own copy of the Model.
 *
 * To add one, write a `RendererDefinition` and list it in registry.ts; see
 * docs/renderers.md.
 */
import type { ComponentType, PointerEvent } from "react";
import type { GraphNodeJson } from "../../api/types.ts";
import type { SceneEnvironment } from "../viewmodel/environment.ts";
import type { GardenView } from "../viewmodel/garden.ts";

/** A commit the viewer chose, for the details panel. */
export interface Selection {
  repoId: string;
  oid: string;
}

export interface RendererProps {
  /**
   * The chosen definition's id. Definitions may share one component (React
   * then keeps its state, such as a camera, across a switch) and tell
   * themselves apart by it.
   */
  rendererId: string;
  garden: GardenView;
  /** The sky and weather; null unless the definition sets `usesEnvironment`. */
  environment: SceneEnvironment | null;
  /** The repository shown alone, or null for the whole garden. */
  focusedId: string | null;
  /** Show one repository alone (a renderer without a focus view may ignore this). */
  onFocus: (repoId: string) => void;
  onExitFocus: () => void;
  selection: Selection | null;
  /** Choose a commit (null closes the details). */
  onSelect: (selection: Selection | null) => void;
  /** Point at a commit, for the shell's tooltip; null when the pointer leaves. */
  onHover: (node: GraphNodeJson | null, event?: PointerEvent) => void;
}

export interface RendererDefinition {
  /** Stable id: config `display.renderer`, `?renderer=`, and saved choices use it. */
  id: string;
  /** Shown in the View menu. */
  label: string;
  description: string;
  /** Compute and pass the sky and weather, and show the sky and weather controls. */
  usesEnvironment: boolean;
  /**
   * Whether the renderer shows its own details panel while a repository is
   * focused; otherwise the shell's drawer shows the selection everywhere.
   */
  ownsFocusDetails?: boolean;
  /**
   * "scene": a full-window picture; the shell floats its panels over it and
   * darkens them at night. "page": an ordinary page on the shell's background.
   */
  layout: "scene" | "page";
  Component: ComponentType<RendererProps>;
  /** Extra controls for the top bar (quality, drawing tier, ...). */
  Controls?: ComponentType;
  /** A short in-page key to what the picture means. */
  Key?: ComponentType<{ environment: SceneEnvironment | null }>;
  /** Variables for the app root (e.g. shadow offsets the renderer's CSS reads). */
  rootStyle?: (environment: SceneEnvironment) => Record<string, string>;
}
