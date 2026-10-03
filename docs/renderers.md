# Build your own renderer

git-flower-garden separates *what* is drawn from *how* it is drawn
([ADR 0022](decisions/0022-pluggable-renderers.md)). The service supplies
the Model: Git history and the environment. Renderers turn it into pictures.
This repository ships four renderers: the technical graph, the hillside
garden (Canvas and SVG), and a small pixel-art garden that is meant to be
copied.

You can build a renderer in one of two ways:

- **In the browser UI**: a React component in this repository. It gets the
  top bar, sky and time controls, weather, the details panel, tooltips, full
  screen, and live updates for free. This page covers this path.
- **Outside the browser**: any program that reads the HTTP API, for example
  an AI video pipeline or a game engine. See [api.md](api.md).

## The layers

```
 Service (Node)                         Browser (src/ui)
 ─────────────────                      ─────────────────────────────────────────
 src/git, src/monitor  ─┐               model/garden-model.ts     the Model store
 src/environment        ├─ HTTP + SSE ─▶ viewmodel/garden.ts       repositories + health
 src/config, src/server ┘  (api.md)     viewmodel/environment.ts  sky, light, weather
                                         shell/ + App.tsx          top bar, controls, details
                                         renderers/<yours>/        your View
```

| Layer | Where | Owns |
| --- | --- | --- |
| Model | `src/` (service), `src/api/types.ts` (contract), `src/ui/model/` (browser store) | Reading Git, monitoring, the sky's place, weather, configuration |
| View model | `src/ui/viewmodel/` | What every renderer needs, derived once: repository health, wilting, markers, the light and weather after the viewer's choices |
| Shell | `src/ui/App.tsx`, `src/ui/shell/` | Renderer choice, sky and weather controls, notices, focus and selection state, details drawer, tooltip, full screen |
| View | `src/ui/renderers/<id>/` | Drawing, and turning pointer and keyboard input into focus and selection |

The rule: **a renderer reads view models and calls callbacks. It never
fetches, and never keeps its own copy of the Model.** That's what lets every
renderer show the same garden at the same moment.

## Quick start: copy the pixel renderer

1. Copy `src/ui/renderers/pixel/` to `src/ui/renderers/<your-id>/`.
2. Rename the definition and give it a unique `id`: lowercase letters,
   digits, and hyphens, starting with a letter (40 characters at most).
3. Add it to `RENDERERS` in
   [`src/ui/renderers/registry.ts`](../src/ui/renderers/registry.ts).
4. Run `npm run dev:ui` with a service running (`git-flower-garden demo`
   serves fictional repositories), then open
   `http://localhost:5173/?renderer=<your-id>`. The *View* menu lists your
   renderer too.

The pixel renderer is split the way we recommend:

- [`pixel-art.ts`](../src/ui/renderers/pixel/pixel-art.ts) is pure. It turns
  view models into a frame and has no DOM. That makes it easy to unit-test
  ([`tests/ui/renderers.test.ts`](../tests/ui/renderers.test.ts)) and easy to
  replace with a WebGL, WebGPU, or video-model back end.
- [`PixelRenderer.tsx`](../src/ui/renderers/pixel/PixelRenderer.tsx) shows
  the frame and maps input back to commits.

## The contract

The contract is defined in
[`src/ui/renderers/types.ts`](../src/ui/renderers/types.ts).

```ts
export const myRenderer: RendererDefinition = {
  id: "watercolor",
  label: "Watercolor",
  description: "Repositories as watercolor washes.",
  usesEnvironment: true, // receive sky + weather; show the sky controls
  layout: "scene", // full-window picture, panels float over it
  Component: Watercolor, // (props: RendererProps) => JSX
  Controls: WatercolorControls, // optional: extra top-bar controls
  Key: WatercolorKey, // optional: a one-line key to the picture
};
```

`RendererProps` provides:

| Prop | What it is |
| --- | --- |
| `garden` | `GardenView`: `phase`, `repositories` (each with `label`, `graph`, `health`, `drawable`, and `index`), `timeZone`, `now`, `reducedMotion` |
| `environment` | `SceneEnvironment` or `null`: `light` (Sun, Moon, sky colors, ambient, stars, shadow), `effects` (cloud, fog, precipitation, wind), `weather`, `rainbow`, `night`, and `preview` |
| `focusedId`, `onFocus`, `onExitFocus` | Show one repository alone, if your renderer has a focus view |
| `selection`, `onSelect` | Choose a commit. The shell's drawer shows its details |
| `onHover` | Point at a commit. The shell shows a tooltip |
| `rendererId` | The chosen definition's id, for definitions that share a component |

The shell handles loading and empty states, so your component only runs
when there are repositories to draw.

## Expectations for renderers in this repository

These come from the roadmap's interaction contract (section 7). A fork can
choose differently.

- **Health without color alone.** Use `health.marker`, `health.wilting`, and
  `health.empty` so that a broken or empty repository is never invisible.
- **Reachable.** Every repository needs a focusable target of at least 44×44
  CSS pixels with an accessible name. Keyboard *Enter* should select or
  focus. *Escape* is handled by the shell.
- **Honor reduced motion** (`garden.reducedMotion` and
  `prefers-reduced-motion`).
- **Same truth.** Don't invent commits or hide refs. If your art can't show
  everything, give a way to reach it, for example selection plus the details
  drawer.
- **Third-party code that ships to users is vendored and reviewed**
  (CONTRIBUTING.md). A large rendering library needs that review before it
  lands here.

## Choosing a renderer

In priority order:

1. `?renderer=<id>` in the URL, for this visit.
2. The viewer's last choice in the *View* menu, remembered in the browser.
3. `display.renderer` in the configuration file (any well-formed id; the
   browser ignores ids it doesn't know).
4. The build's default: `technical` for the installed service, `canvas` for
   the online demo.
