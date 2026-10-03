# 0022: Pluggable renderers over a shared Model and view models

- Status: Proposed (draft for maintainer review)
- Date: 2026-10-03
- Roadmap: section 2 ("One graph, multiple renderers"), section 7
- Amends: [ADR 0005](0005-initial-rendering-stack.md) (renderers become
  registered plug-ins rather than a fixed pair). `display.renderer` in the
  configuration is no longer limited to `technical`.

## Context

The maintainer's goal (2026-10-03) is for git-flower-garden to support many
renderers of the same garden. Pixel art, a path-traced scene, or AI-generated
video should be able to show the same Git history and the same sky, and
anyone should be able to fork the repository and add their own. The core
models that supply Git and weather information should stay shared.

Before this record, `src/ui/App.tsx` (1,100 lines) handled everything at
once. It held live data loading (server-sent events and graph fetches),
health rules (wilting, markers, empty repositories), sky and weather
derivation, the three drawing paths (technical SVG, garden Canvas, and
garden SVG), and every control. The renderer was a closed union
`"technical" | "canvas" | "svg"`, branched on in about 20 places. Adding a
renderer meant editing all of them.

The maintainer chose (2026-10-03):

1. **The Model boundary on both sides**: the HTTP/SSE contract, documented
   for any language, and a typed in-browser Model store and view models for
   renderers in the UI.
2. **A registry with a runtime choice**: renderers register in one file. The
   viewer picks one from the URL, the *View* menu, or the configuration.
3. **This change's scope**: restructure the code, move the existing views
   behind the interface with no visual change, add a minimal pixel-art
   renderer as a template, and document how to write a renderer.

## Decision

A Model–ViewModel–View split. The *shell* plays the role that a
controller or coordinator plays in MVVM.

| Layer | Code | Responsibility |
| --- | --- | --- |
| Model (service) | `src/git`, `src/monitor`, `src/environment`, `src/config`, `src/server` | Read Git, monitor, fetch weather, and serve the API. Unchanged |
| Model (contract) | `src/api/types.ts`, [docs/api.md](../api.md) | The JSON and SSE wire format, versioned by `apiVersion`. Additive changes keep the version |
| Model (browser) | `src/ui/model/garden-model.ts` | One framework-free store (`subscribe`/`getSnapshot`) filled by the live service or the static demo snapshot. It replaces the `useLiveData`/`useSnapshotData` hooks, with the same ordering and staleness rules |
| View model | `src/ui/viewmodel/garden.ts`, `environment.ts` | Pure derivations every renderer shares: per-repository health (state glyph, wilting, empty, remote down, marker), drawability, and the scene light after the viewer's time and weather choices |
| Shell | `src/ui/App.tsx`, `src/ui/shell/` | Renderer choice, top bar, notices, sky and weather controls, focus and selection state, Escape handling, details drawer, tooltip, full screen |
| View | `src/ui/renderers/<id>/` | Draw the view models. Report focus, selection, and hover through callbacks |

### The renderer contract

`RendererDefinition` (`src/ui/renderers/types.ts`) has these fields:

- `id`, `label`, and `description`.
- `usesEnvironment`: the shell computes the sky and weather only for
  renderers that use them, and shows their controls only then.
- `layout`: `"scene"` (a full-window picture with panels floating over it
  and darkened at night) or `"page"`.
- `Component`, which receives `RendererProps`.
- Optional `Controls`, `Key`, and `rootStyle`, and `ownsFocusDetails` for a
  renderer whose focus view shows its own details panel.

A renderer never fetches and never holds Model state.

`src/ui/renderers/registry.ts` lists the renderers in menu order. A fork
adds one import and one entry.

The three existing views become `technical`, `canvas`, and `svg`, with the
same ids, labels, and saved choices as before. All three use one component,
`ClassicRenderer`, so React keeps the focus camera and selection when the
viewer switches between them, as before (`botanical.spec.ts`).
`RendererProps.rendererId` tells the component which one it is. The garden
engine modules (`src/ui/scene/`, `botanical.ts`, `GardenCanvas.tsx`, and so
on) stay where they are. Moving them under `renderers/classic/` is left for
a quiet period, because ADR 0018 and ADR 0021 are under active change and
the move would touch about 20 test, script, and documentation paths.

### Choosing a renderer

In priority order: `?renderer=<id>` (this visit only), the viewer's last
*View* choice (this browser), `display.renderer` from the configuration,
then the build default (`technical` for the service, `canvas` for the
Pages demo). Unknown ids are skipped at every step.

`display.renderer` now accepts any id matching `^[a-z][a-z0-9-]{0,39}$`.
The service can't know which renderers a browser build registers, so the
browser does the fallback. The value is served as `display.renderer` (a
new optional field; `apiVersion` stays 1).

### The pixel-art renderer

`src/ui/renderers/pixel/` is a deliberately small renderer:

- `pixel-art.ts` is pure: view models in, a 128×72 RGBA frame out. It draws
  a banded, dithered sky from the light model; the Sun, the Moon, and stars;
  a ridge and a hillside lit by the day; one plant per repository built from
  its graph (stems from parent links, dashed where history is hidden;
  flowers for branch heads, leaves for commits, red fruit for tags, and dark
  knots for common ancestors); grey wilting plants; stakes for unhealthy
  repositories; rain, snow, and fog.
- `PixelRenderer.tsx` blits the frame with `image-rendering: pixelated` and
  places one 44-pixel-minimum button per plant. The buttons are focusable,
  named, and show the state glyph when something is wrong. A click selects
  the commit under the pointer, or the newest branch head, and the shell's
  drawer shows the details.

The pixel renderer has no focus view. The focus view is optional in the
contract.

## Consequences

- Adding a renderer touches one folder and one registry line, and needs no
  change to the shell or the service. [docs/renderers.md](../renderers.md)
  is the guide.
- Renderers outside the browser (a Python or Unreal client) use the
  documented HTTP API. They compute the Sun and Moon themselves from the
  place the service reports. The Sun and Moon positions are not served,
  because the browser computes them from the same vendored astronomy-engine
  (ADR 0019).
- The health rules exist once (`repositoryHealth`) instead of inline in the
  classic plots, so every renderer reads the same health signals
  (roadmap section 7, "health without text").
- The garden's appearance is unchanged. The garden HUD still reads the
  relit, *shown* light (`useShownLight`) for night panels and shadows. That
  light is part of `SceneEnvironment` as `shownLight`. For renderers that
  relight at once, it equals `light`.

## Verification

- `tests/ui/renderers.test.ts`: garden view model phases and health in
  configuration order; the pixel frame is full, opaque, and deterministic;
  plants map commits back for hit testing, with newer commits higher;
  wilting greys a plant.
- `tests/config/config.test.ts`: any well-formed `display.renderer` is
  accepted, and malformed ones are rejected at their pointer.
- `tests/e2e/garden-scene.spec.ts`, "the pixel renderer…": `?renderer=pixel`
  opens it, every repository is a target in configuration order, a broken
  repository carries a marker, the frame is drawn, *Enter* opens the shell's
  details, *Escape* closes them, and an unknown id falls back.
- The full existing browser suite (40 tests: interaction, touch, botanical,
  fidelity, garden scene, weather, full screen) passes unchanged.
