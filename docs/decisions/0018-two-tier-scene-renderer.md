# 0018: Two-tier scene renderer: optional WebGL2 relighting over a Canvas 2D baseline

- Status: Proposed (draft for maintainer review)
- Date: 2026-09-27
- Roadmap: sections 3, 10 (P2-C, P2-D, P2-E), 12
- Amends: [ADR 0005](0005-initial-rendering-stack.md) ("WebGL needs a measured
  bottleneck and its own ADR")

## Context

The rest of Phase 2 asks for a living scene: a layered Blue Ridge setting, a
real sun and moon with correct light from dawn through night, cloud, rain,
snow, wind, rainbows, and restrained sway (P2-C, P2-D), with quality presets,
a static low-power mode, and a budget of under 10% machine CPU at 30 fps on
the reference machine, a 2017 Surface Pro (Core m3, Intel HD 615) (P2-E,
section 12).

Today the garden is one flattened daytime backdrop and a four-sprite atlas,
both with upper-left light painted in. The four lighting studies are CSS
color grades of that one image (ADR 0015).

The maintainer's constraints (2026-09-27):

1. **Hardware acceleration stays optional.** Every feature must have a path
   that runs without a GPU.
2. **No new third-party runtime code.** npm stays for development tools and
   installation, but nothing new is shipped to users from a package
   registry, given the rate of supply-chain attacks. "Runtime" includes
   anything Vite bundles into `dist/ui`; React is the existing exception.
3. **Lighting should follow the sun**: shading and shadows respond to the
   actual sun direction, not only a time-of-day tint.
4. **A reduced software tier is acceptable**: without a GPU, fewer particles,
   less frequent relighting, and simpler effects, but still animated.

## Options considered

| Option | Runs without a GPU | Sun relighting | New runtime dependency | Verdict |
| --- | --- | --- | --- | --- |
| Three.js, Babylon.js | No (WebGL/WebGPU only) | Yes | Yes, large | Rejected: violates 1 |
| Godot (web export) | No (WebGL 2 required) | Yes | Engine runtime; replaces the React/SVG layer | Rejected: violates 1, and breaks ADR 0005/0015's interaction layer |
| Phaser | Canvas mode, without shaders | GPU mode only | Yes, a full game framework | Rejected: still needs two tiers, and brings a scene graph that competes with the SVG interaction layer |
| PixiJS | Not verified for v8 | Yes | Yes | Rejected: covers only the GPU half; the Canvas 2D tier would still be ours |
| Relying on software WebGL (SwiftShader, llvmpipe) | Nominally | Yes, slowly | No | Rejected: browsers are withdrawing automatic software WebGL fallback, and it is too slow for the budget |
| **Own renderer: WebGL2 tier plus Canvas 2D tier** | **Yes** | **GPU tier** | **None** | **Chosen** |

Browser Canvas 2D is itself GPU-accelerated where available and falls back
to CPU rasterization, which is exactly the "optional" behavior wanted, so it
remains the baseline.

## Decision

### One scene, two drawing tiers

The scene is computed once, as plain data, and drawn by either tier:

```
clock + location ──► astronomy ──┐
weather provider (optional) ─────┼─► EnvironmentSnapshot ─► LightingState ─┐
visible graph ─► layout ─► botanical scene (src/ui/botanical.ts) ──────────┼─► SceneDescription ─► GPU tier | software tier
hillside slots, quality preset ────────────────────────────────────────────┘
```

- **`LightingState`** (pure, unit-tested): sun and moon direction in scene
  space, sun color and intensity, ambient and sky colors (gradient stops),
  horizon haze, star visibility, moon phase and limb angle, and shadow
  direction and length. It is derived only from `EnvironmentSnapshot` and so
  works offline from astronomy alone.
- **`WeatherState`** (pure): cloud cover, precipitation type and intensity,
  wind, and a rainbow flag inferred as roadmap P2-D describes.
- **`SceneDescription`**: layers, sprites (position, anchor, scale, albedo
  and normal-map cells, seed), stems, particles, and their caps for the
  active preset. It extends the existing botanical scene function; both
  garden compositors already draw from one scene, so this generalizes an
  existing pattern rather than adding a new one.

The technical SVG stays above both tiers as the interaction, text, and
accessibility layer (ADR 0005, 0015, 0017). Artwork never changes what is
hovered, clicked, selected, or read.

### GPU tier: WebGL2, written here

A small hand-written WebGL2 renderer, with no library:

- a full-screen sky pass (gradient, sun disc and glow, stars, moon with phase
  shading), computed from `LightingState`;
- one batched, instanced sprite pass that lights each sprite from its albedo
  and normal-map cells using the sun direction, with ambient and rim terms;
- backdrop layers (ridges, hill) lit the same way, with height-based haze;
- projected soft shadows beneath plants, following the sun;
- instanced particles for rain and snow, and a vertex-shader wind sway that
  never moves hit targets.

WebGL2 rather than WebGPU: WebGL2 is universal on the supported platforms;
WebGPU support on Linux is still uneven. WebGPU can be a later ADR if a
measured need appears.

### Software tier: Canvas 2D

- **Keyframed lighting**: backdrop layers and sprites are pre-lit into
  offscreen canvases for the current `LightingState` by blending authored
  keyframes (dawn, day, dusk, night) and tinting. The pre-lit layers are
  rebuilt only when lighting changes meaningfully (sun moved more than about
  half a degree, or weather changed; in practice about once a minute), never
  per frame.
- The sky is a Canvas gradient from the same `LightingState` stops, so the
  sky color matches the GPU tier exactly; only the shading of sprites and
  layers is approximated.
- Particles, sway, and frame rate follow a lower cap (initially 15 fps while
  animating; exact caps are set by the measurements below). Only the regions
  that change are redrawn over the cached layers.

### Choosing a tier

1. **Auto** (default): request
   `getContext("webgl2", { failIfMajorPerformanceCaveat: true, powerPreference: "low-power" })`.
   If it fails, or software WebGL would be used, choose Canvas 2D. After
   start, a short frame-time probe downgrades to Canvas 2D if the GPU tier
   misses its budget.
2. On `webglcontextlost`, drop to Canvas 2D immediately; try the GPU tier
   again after the context is restored.
3. The View menu offers **Auto, GPU, Software, Static**. Static draws one
   lit frame per lighting change and nothing between (the roadmap's static
   low-power mode). The choice is remembered per browser, like the renderer
   choice (failure-safe `localStorage`).
4. `prefers-reduced-motion` turns off sway and particles in every tier;
   lighting still changes, gradually.
5. Nothing draws while the page is hidden (existing behavior).

### Art pipeline

Relighting needs art authored for it, which is the largest cost of this
decision:

- **Sprites** are generated **flat-lit** (even light, no cast shadows) as an
  albedo atlas, plus a matching **normal-map** atlas in the same grid.
- **Backdrop** is separate transparent layers (far, middle, and near ridges,
  the hill), not one flat image. The sky becomes procedural, so it needs no
  art beyond optional cloud sprites.
- **Software keyframes** are rendered from the same albedo and normals by a
  development-only script (`scripts/`, never shipped), so the two tiers
  cannot drift apart in design.
- **Generation**: images are generated with the Codex CLI available on the
  maintainer's machine, as in P2-A. Every prompt goes in
  [docs/art/prompts.md](../art/prompts.md) and every file in the asset
  manifest with its provenance, under the MIT decision of ADR 0015.
- **Normal maps** from an image model may be inaccurate. The spike compares
  Codex-generated normal maps with normals derived by a development-only
  script (a rounded shape from the sprite's silhouette plus detail from
  luminance). The script is deterministic and needs no model.
- The P2-A tool returned images smaller than requested (1672×941 for a 4K
  backdrop). Native 4K layers may need generation in tiles or at reduced
  detail per layer; the spike records what Codex actually returns.

## Delivery order

1. **Lighting model**: `EnvironmentSnapshot` to `LightingState`, with the
   developer overrides P2-D asks for (sunrise, sunset, night, moon phases,
   and so on). This is pure code and needs no art. It starts with the
   astronomy question below.
2. **Art spike** (gate): one ridge layer, the hill, and the four sprites,
   each as flat albedo plus normals, generated with Codex. Build a throwaway
   comparison page: Canvas 2D keyframed against WebGL2 relit, at dawn, noon,
   dusk, and night, on the dedicated monitor and on the reference machine.
   **The maintainer decides whether sun relighting reads clearly better than
   keyframes.** If it does not, the GPU tier is dropped, this ADR is
   rewritten as Canvas 2D only, and the art needs no normal maps.
3. **Software tier** in full, since every viewer gets it.
4. **GPU tier**.
5. **Weather** in both tiers, with presets and particle caps.
6. **Presets, measurements, and the P2-E soak.**

## Verification

- Unit tests: `LightingState` against published reference cases (via the
  astronomy work), and `SceneDescription` stability (same inputs, same scene).
- Browser tests force each tier with the View-menu override. In Chromium
  run with `--disable-gpu`, **Auto** must choose Canvas 2D. Both tiers must
  keep the existing graph-fidelity and hit-target tests passing unchanged.
- The screenshot matrix gains lighting (dawn, noon, dusk, night, polar day)
  and weather cases for each tier, as review evidence rather than pixel
  goldens (as in ADR 0015).
- Measurements on the reference machine at 1080p (and the dedicated monitor's
  resolution): CPU and GPU use while animating and while idle for GPU,
  Software, and Static, recorded in this record before it is accepted.

## Consequences

- ADR 0005's rule is amended: WebGL is adopted because a feature (sun
  relighting) needs it, not because of a measured bottleneck. It remains
  optional and never the only path.
- Two drawing tiers are more code to maintain than one. The shared
  `SceneDescription`, a single lighting model, and development-time keyframe
  baking keep the difference to how pixels are shaded.
- The art library roughly doubles in files (albedo and normals, layered
  backdrop). Generation stays reproducible through recorded prompts.
- No new runtime dependency is shipped.

## Open questions for the maintainer

1. **Dedicated monitor**: its resolution and GPU, if it is not the Surface
   Pro. This sets the native art size and the second measurement target.
2. **Astronomy**: write our own sun and moon routines (NOAA solar
   equations and a Meeus-style lunar model, about 300 lines, tested against
   published tables), or vendor one pinned, checksummed file from an
   MIT-licensed library such as astronomy-engine? Either satisfies
   constraint 2; the first avoids third-party code entirely.
3. **Software-tier sway**: keep a slow sway at 15 fps, or reserve sway for
   the GPU tier?

## On acceptance

Update roadmap section 3 ("Phase 2 drawing"), the P2-C, P2-D, and P2-E items
this changes, and the index in [README.md](README.md), together.
