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

The dedicated monitor runs on an integrated NVIDIA GPU with 4 GB of video
memory. **The design target is 1920×1080**, adapting to other resolutions
and aspect ratios (roadmap P2-C).

Today the garden is one flattened daytime backdrop and a four-sprite atlas,
both with upper-left light painted in. The four lighting studies are CSS
color grades of that one image (ADR 0015).

The maintainer's constraints (2026-09-27):

1. **Hardware acceleration stays optional.** Every feature must have a path
   that runs without a GPU.
2. **No runtime code from a package registry.** npm stays for development
   tools and installation, but nothing new is shipped to users from npm,
   given the rate of supply-chain attacks. "Runtime" includes anything Vite
   bundles into `dist/ui`; React is the existing exception. Third-party code
   may ship only from a Git submodule pinned at a reviewed commit, with
   checksum tests (see "Astronomy" below, and ADR 0019).
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

- **Exact lighting, computed rarely** (amended 2026-09-27, maintainer
  decision; this replaced blended keyframes): a Web Worker lights every
  texel of the backdrop layers and sprite atlases on the CPU with the same
  `shade` function the GPU tier's shader mirrors, from the albedo, normal,
  and translucency maps, and returns bitmaps. It runs only when the light
  changes meaningfully (the Sun moved about 0.3° or colors changed about
  0.5%; in practice every minute or two while the Sun is up), never per
  frame. So the software tier matches the relit look exactly, including the
  season, the Sun's side, front fill, and translucency, which keyframes
  could not know; there are no keyframe images and no bake script. The
  spike's keyframed half showed those limits (step 2).
- The sky is a Canvas gradient from the same `LightingState` stops, so the
  sky color matches the GPU tier exactly; only the shading of sprites and
  layers is approximated.
- Particles and frame rate follow a lower cap (initially 15 fps while
  animating; exact caps are set by the measurements below). Only the regions
  that change are redrawn over the cached layers.
- **Sway stays in the software tier** (maintainer decision, 2026-09-27): a
  slow, low-amplitude sway at the tier's frame rate, drawn by offsetting
  pre-lit sprites along the stem. It is the first effect the frame-time probe
  reduces, and it is off under reduced motion as in every tier.

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

### Resolution

Art and layout are designed at **1920×1080 CSS pixels** and adapt from
there:

- Backdrop layers are authored at 1920×1080 with bleed for wider and taller
  aspect ratios (portrait, ultrawide), anchored like today's center-bottom
  `cover` backdrop; the hillside slot table (ADR 0015) keeps its
  proportional positions.
- Sprites are authored at 2× their largest 1080p on-screen size, so they stay
  sharp at device pixel ratio 2 (a 4K display at 200% scaling) and scale
  down cleanly.
- Both tiers render at the display's device pixel ratio, capped at 2, with
  the existing Canvas area limits (ADR 0015). The GPU tier may render its
  backdrop at a lower internal resolution under the Low preset.
- Above 1080p, layers are upscaled rather than re-authored; native 4K art is
  not a goal of this ADR. On the dedicated monitor's 4 GB GPU, texture
  memory is not a constraint at this size: about five layers at 1080p plus
  bleed, each with albedo and normals, come to roughly 100–150 MB
  uncompressed, before atlases. The Surface Pro shares system memory with
  its GPU, so there it is measured, and the Low preset halves layer
  resolution.

### Astronomy: vendored astronomy-engine

Sun and moon positions come from
[astronomy-engine](https://github.com/cosinekitty/astronomy) (Don Cross),
decided by the maintainer on 2026-09-27, and accepted after a security review
([ADR 0019](0019-astronomy-engine-review.md)):

- **License**: MIT, the same as this project; the copyright and permission
  notice ship with it. No licensing concern found.
- **Form**: a Git submodule at `vendor/astronomy-engine`, pinned to the
  v2.1.19 release commit (`61dc070`), cloned shallow. Code imports the
  compiled ES module and its types through the package's own
  `#astronomy-engine` import alias (`package.json` `imports`), never from
  npm. Tests pin the reviewed files by SHA-256.
- **Size**: tree-shaking keeps what the scene uses; the current wrapper
  bundles to about 75 KB minified (25 KB gzipped), against 135 KB for the
  whole library.
- **Dependencies**: none. It computes offline from published models, with
  no network access, which matches P2-D's offline requirement.
- **Maintenance**: the last release is from December 2023 (last repository
  activity January 2025). It is mature, computational code with no external
  interfaces, so low churn is acceptable. Reference-case tests guard against
  errors; upgrading means moving the pin, re-reviewing the diff, and updating
  the checksums (ADR 0019).
- **Where it runs**: in the browser, beside `LightingState`, so the scene
  can animate time smoothly without polling the service. It covers P2-D's
  sun altitude and azimuth, rise and set times, moon altitude, illuminated
  fraction, and phase angle; limb orientation is derived from the sun and
  moon positions it returns. The wrapper is `src/environment/astronomy.ts`.

### Art pipeline

Relighting needs art authored for it, which is the largest cost of this
decision:

- **Sprites** are generated **flat-lit** (even light, no cast shadows) as an
  albedo atlas, plus a matching **normal-map** atlas in the same grid.
- **Backdrop** is separate transparent layers (far, middle, and near ridges,
  the hill), not one flat image. The sky becomes procedural, so it needs no
  art beyond optional cloud sprites.
- **Both tiers light from the same maps with the same `shade` function**
  (`src/ui/scene/shading.ts`), so they cannot drift apart in design. (The
  development-time keyframe script first planned here is not needed; see
  "Software tier".)
- **Generation**: images are generated with the Codex CLI available on the
  maintainer's machine, as in P2-A. Every prompt goes in
  [docs/art/prompts.md](../art/prompts.md) and every file in the asset
  manifest with its provenance, under the MIT decision of ADR 0015.
- **Normal maps** from an image model may be inaccurate. The spike compares
  Codex-generated normal maps with normals derived by a development-only
  script (a rounded shape from the sprite's silhouette plus detail from
  luminance). The script is deterministic and needs no model.
- The P2-A tool returned images smaller than requested (1672×941 for a 4K
  backdrop). At the 1080p target, layers need at least 1920×1080 plus bleed;
  where Codex returns less, the spike records it and generates in tiles or
  upscales with review.

## Delivery order

1. **Lighting model**: `EnvironmentSnapshot` to `LightingState`, with the
   developer overrides P2-D asks for (sunrise, sunset, night, moon phases,
   and so on). This is pure code and needs no art. astronomy-engine is
   vendored and wrapped already (ADR 0019).
2. **Art spike** (gate): one ridge layer, the hill, and the four sprites,
   each as flat albedo plus normals, generated with Codex. Build a throwaway
   comparison page: Canvas 2D keyframed against WebGL2 relit, at dawn, noon,
   dusk, and night, at 1920×1080 on the dedicated monitor and on the
   reference machine.
   **The maintainer decides whether sun relighting reads clearly better than
   keyframes.** If it does not, the GPU tier is dropped, this ADR is
   rewritten as Canvas 2D only, and the art needs no normal maps.
3. **Software tier** in full, since every viewer gets it.
4. **GPU tier**.
5. **Weather** in both tiers, with presets and particle caps.
6. **Presets, measurements, and the P2-E soak.**

## Progress

- **Step 1, lighting model: done** (2026-09-27). `src/environment/`:
  `environment.ts` (snapshot with an injectable clock), `lighting.ts`
  (`LightingState`: panoramic projection, twilight, sky keyframes, sun
  color, shadows, stars, moonlight, and the Moon's limb angle), and
  `overrides.ts` (twelve developer previews). The configuration gains
  `environment.latitude`, `longitude`, `elevationMeters`, and `timeZone`.
  Until layered art exists, the garden view grades the flat backdrop from
  `LightingState` (interpolating the four P2-A studies) and draws the Sun,
  Moon, and stars above the far ridgeline. The painted upper-left sunlight
  in that backdrop does not follow the Sun, which is what step 2 addresses.
  The UI now bundles astronomy-engine; its notice ships in
  `THIRD-PARTY-NOTICES.md` (ADR 0019, condition 3).
- **Step 2, art spike: built, awaiting the maintainer's decision**
  (2026-09-27). [spikes/relight](../../spikes/relight/README.md) (`npm run
  spike:relight`) draws one ridge layer, the hill, and the four sprites,
  generated flat-lit with Codex together with Codex normal maps, side by side
  as WebGL2 relit and Canvas 2D keyframed, with normals derived by script as
  the alternative. Findings so far: flat-lit generation works; the image tool
  caps sizes (1672×941 layers) and keys transparency with noisy alpha; Codex
  normal maps are plausible but one came back with its X axis inverted, so
  every map needs a convention check. The spike also raises an art-direction
  question: real light from a southern Sun backlights the south-facing scene
  most of the day, so it offers light mirrored to the viewer's side.
  **Maintainer's decision (2026-09-27): relit, with Codex-generated normal
  maps**; performance was fine in both tiers, even on a first-generation
  Surface Pro. Light stays physical, with a translucency term for grass,
  petals, and leaves lit from behind, and a front fill (bounced light) on the
  hillside and plants only, never the mountains. **Locked by the maintainer
  (2026-09-27): front fill 50% of the Sun and Moon mirrored to the viewer's
  side; translucency 100%, per texel from Codex-generated translucency maps**
  (sprites and hill; none on the mountains). Art for the GPU tier therefore
  comes in three maps per layer: flat-lit albedo, normals, and translucency,
  each checked for alignment and convention. Measurements on the reference
  hardware were waived: performance was fine in both tiers, even on a
  first-generation Surface Pro.

- **Step 3, software tier: lighting done** (2026-09-27). The maintainer
  chose exact CPU relighting over keyframes and promoted the spike art
  (ridge, hill, and sprites, each with Codex normal and translucency maps)
  to production, `src/ui/assets/scene/`, with checksums in the asset
  manifest; the P2-A atlas and backdrop are retired to `docs/art/p2a/`.
  `src/ui/scene/`: `shading.ts` (moved from the spike, with the locked 50%
  fill and 100% translucency and a per-texel translucency input),
  `relight.ts` (pure, tested), `worker.ts` and `client.ts` (one worker per
  page; the last lit art stays up while the next is computed), and
  `view.ts` (cover transform, sky bodies, stars, relight key, lit colors).
  `SceneCanvas.tsx` replaces the CSS-graded backdrop and DOM sky with one
  Canvas 2D drawing of the sky, Sun, Moon, stars, and relit layers, redrawn
  only when the light, the lit art, or the window changes. Both garden
  compositors draw sprites from the relit atlases (a separately lit mirror
  for mirrored sprites) and procedural stems, knots, and halos in colors
  lit the same way. Plants' drop shadows now fall away from the Sun and
  vanish at night. Two decisions made while building, for the maintainer's
  review: the focus view lights its plant with the noon preview light,
  because a dusk- or moonlit plant was dark and muddy on the pale
  inspection card; and without a configured location the garden is lit by
  the noon preview. All 64 hillside slots were checked against the new hill
  and still sit on grass, so the table is unchanged. The CSP allows `blob:`
  images (the SVG compositor's relit atlases) and names `worker-src 'self'`.
  Measured in headless Chromium on a first-generation Surface Pro (Core
  i5-3317U, 2 cores and 4 threads, 4 GB), the machine these sessions ran on
  (confirmed by the maintainer, 2026-09-28): 290–470 ms of worker time per
  relight at 1672×941 layers and a 512-pixel sprite atlas, and 378–592 ms
  per relight back to back while the time of day loops, well within the
  2-second bar. The 2017 reference machine (Core m3) was not measured
  separately; the focus
  view's 2,000-commit timings match or beat the previous build on the same
  machine. **Open in step 3**: a `SceneDescription` shared with the GPU
  tier (plants are still drawn per plot; done 2026-09-30, below). Sway, the frame-rate cap, and the
  tier choice followed on 2026-09-29 (below).
  **Maintainer review of the two decisions** (2026-09-28): daylight in the
  focus view stays for daylight hours; after civil dusk the panels over the
  scene, the focus view included, turn dark (its plant stays daylit).
  Without a configured place the sky is Blacksburg, Virginia's, rather than
  a fixed noon (`environment.enabled` now defaults to true; `false` keeps
  the noon light). Built on `feat/pages-demo`, merged after PR #1 as PR #2.
  **Time slider, loop, and cores** (2026-09-28, same branch): the time of
  day can be dragged or looped (a day every 30 seconds), so relights are no
  longer rare. The scene repaints only when a whole frame is lit: sky, Sun,
  Moon, stars, and shadows are drawn for the light of the art on screen.
  The worker now lights each layer in bands of rows, one band worker per
  spare core (`band.ts`; byte-identical to lighting whole, tested). On a
  4-core desktop in headless Chromium, lighting fell from about 540 ms to
  280 ms per relight, but a looping scene still repaints only about twice
  a second: the four cores are saturated, and overlapping the next
  relight's lighting with the last one's packing gained nothing, so it was
  left out. An inlined `shade` kernel was no faster than the function (the
  engine inlines it) and was dropped. Smooth looping needs the GPU tier
  (step 4).
- **Step 3, software tier: sway, frame-rate cap, and tier choice**
  (2026-09-29). Leaves, flowers, and fruit rock up to about 3.4° about the
  point where they meet their stem (`src/ui/sway.ts`, pure and tested): a
  slow breeze crossing the garden plus a seeded rhythm per sprite, so
  neighbors never move in lockstep. Stems, knots, and every hit target stay
  put. Sway is for the garden view only; the focus view holds still for
  reading. One shared clock (`src/ui/motion.ts`) drives every plant at 15
  fps, the software tier's cap, from a timer that asks for one animation
  frame per drawn frame; growth transitions follow the same cap. Nothing
  moves while the page is hidden, under reduced motion, or in Static. The
  frame-time probe stops sway for the visit when the median of 30 frame
  gaps runs past 1.5 frames. The View controls gain **Drawing**: Auto,
  Software, Static, remembered per browser; GPU joins in step 4, and
  until then Auto means Software. Hillside plant canvases are now drawn at
  the size they are shown (CSS scales them into place), not their layout
  size. **Measured** on the Surface Pro in a visible Chromium window using
  the Intel HD 4000 (Mesa), the Pages demo's eight plants at 1920×1080,
  over 20 s: Static, about 0% of the main thread and 0–5% of one core for
  the whole browser; Software at 15 fps, about 18% of the main thread and
  about 100% of one core, mostly in the GPU process. The cost scales with
  the frame rate (8 fps: about 80%; 5 fps: about 50%) and hardly with what
  is drawn: clearing the plant canvases each frame and drawing nothing cost
  the same, and removing the backdrop blur, plant filters, sky canvas, or
  top bar, drawing canvases at shown size, caching stems, or forcing CPU
  canvases saved 20 points at most. It is Chromium's per-frame cost for
  changed canvases on this GPU. Frames arrive on time, so the probe does
  not trip. **Maintainer decision** (2026-09-29): keep 15 fps and accept
  the development machine's limits; scale back in the polish phase (P2-E)
  if needed. The dedicated monitor's machine is not yet measured. Merged to `main` on 2026-09-29 (PR #5).
- **Step 3, software tier: one scene** (2026-09-30). `SceneDescription`
  (`src/ui/scene/description.ts`, pure and tested) is the garden as data:
  the backdrop layers and every hillside plant, back to front (by slot row,
  then configuration order; the highlighted plant last), each with its
  botanical scene in graph coordinates, the affine placement that stands
  its lanes on its slot in the 1920×1080 design space, the box its art can
  reach while swaying, and whether it is wilting or highlighted. The same
  inputs give an equal description, and each graph's scene is computed once
  and shared. Particles and their caps join with weather (P2-D). With the
  Canvas compositor, one stage-sized canvas (`GardenCanvas.tsx`) now draws
  every plant from it; each plot keeps only its SVG hit and label layer,
  and its markers (bed, stake) keep their CSS shadow and outline. Painting
  a plant is shared with the per-plot canvases (`paint.ts`). The canvas
  also draws the hidden-commit badges, which the botanical scene now
  carries (`collapsedBadge`, shared with the technical drawing): with one
  canvas under every plot, the plots' own badges would have shown through
  the plants in front, so those are hidden on the hillside. The drop
  shadow, the cyan outline, and wilting, which were CSS filters on each
  plot, are drawn by the canvas with the same filters. Canvas filters and
  canvas-to-canvas copies proved costly per frame (in headless Chromium, 8
  plants fell from 69 frames in 4 seconds to 9 when every plant was
  filtered each frame), so each plant's shadow and its whole look at rest
  are cached and rebuilt only when the light, the canvas size, the plant's
  history, or its highlight changes; a sway frame draws the cached shadow
  and paints the plant over it. **Decision for the maintainer's review**:
  the highlighted plant and wilting plants hold still in the garden, drawn
  from their cached look, so the outline fits exactly and no filter runs
  per frame (the SVG compositor still sways them). **Measured**
  (`npm run measure:garden`) on the Surface Pro in a visible Chromium
  window using the HD 4000, 1920×1080, the noon preview, over 20 s, in
  percent of one core: 8 plants swaying, 79–81% (GPU process 57–59,
  renderer 20), against 100–102% for the per-plot canvases measured the
  same way (GPU process 78–79); Static 2%, as before. 64 plants: the
  per-plot canvases fell behind and the probe stopped sway (about 5%);
  one scene keeps them swaying at 159% (GPU process 118, renderer 39),
  and 2% in Static. Headless, the canvas's script time is about 2 ms a
  frame for 8 plants and 9 ms for 64. Most of the remaining cost is still
  Chromium's handling of a changed canvas each frame, for the GPU tier to
  remove. Merged to `main` on 2026-09-30 (PR #6).
- **Step 4, GPU tier: the landscape** (2026-09-30). `src/ui/scene/gpu.ts`
  draws the sky, Sun, Moon, and stars with WebGL2 and relights the ridge
  and hill per pixel from their albedo, normal, and translucency maps, in
  a shader that mirrors `shade` line for line and decodes the maps as
  `relight.ts` does (alpha snapped at both ends, the hill's X axis
  flipped). The plants are still drawn by the Canvas 2D scene canvas from
  sprites relit in the worker, which now lights only the sprites while the
  GPU draws the landscape (about a seventh of the texels). The landscape
  is drawn for the light of those sprites, as in Software, so a frame
  still never mixes two times of day. **Choosing a tier**
  (`src/ui/scene/tier.ts`, pure and tested): the Drawing choice gains
  **GPU**; Auto takes it only on graphics hardware. Headless Chromium
  passes SwiftShader off as having no major performance caveat, so
  `failIfMajorPerformanceCaveat` is not enough: the renderer's name is
  checked for software rasterizers too. GPU chosen by hand accepts
  software WebGL, which is how the browser tests force it. Static draws
  with Canvas 2D. A lost context hands the landscape to Software at once
  (the worker relights the ridge and hill again), and the GPU canvas stays
  mounted to take over again when the context is restored; any failure to
  start (no context, a shader, or the art) falls back to Software for the
  visit. **Verified**: in headless Chromium, the GPU and Software tiers
  agree within 6 of 255 levels in the sky, ridge, hill, and grass at
  sunrise, civil dusk, full moon, and noon; fewer than 0.1% of pixels
  differ by more than 8 (plants mid-sway, anti-aliased edges). Auto picks
  Software for SwiftShader; context loss and restore hand over both ways
  (`tests/e2e/botanical.spec.ts`). Browser tests that depend on what Auto
  sees fake the WebGL renderer's name and the performance caveat, since
  CI machines differ: GitHub's macOS runner has a GPU in headless Chrome,
  and Windows' fails the caveat. **Measured** (`npm run
  measure:garden`, now with `LOOP=1` and the tier that drew) on the
  Surface Pro in a visible Chromium window: Auto chose the GPU on the HD
  4000 (Mesa, OpenGL ES 3.0). Looping the day with 8 plants, the scene
  repainted 8.3 times a second with the GPU against 2.7 with Software;
  both keep the machine's four threads busy (about 250% of one core), now
  mostly relighting sprites. At rest (noon, swaying), GPU and Software
  cost the same, 80–81% of one core, since the landscape does not redraw
  per frame; the cost is the plants' canvas.
- **Step 4, GPU tier: the plants** (2026-09-30). `src/ui/scene/plants-gpu.ts`
  draws every hillside plant of the `SceneDescription` with WebGL2, back
  to front, lit each frame by the same shading as the landscape; the
  shader copy of `shade` now lives once, in `src/ui/scene/gl.ts`, for both.
  Per plant, in the software tier's order: the drop shadow (a blurred
  silhouette made once per plant and size; the Sun's offset and fade are
  uniforms, so light never rebuilds it) or the cyan outline; ground
  shadows as ellipses; stems and knots, drawn unlit by the shared Canvas
  painters into a texture that is rebuilt only while the plant grows, and
  lit in the shader by `stemLight`, which is exactly what `litColor`
  applies (unit-tested); sprites, instanced from the full-resolution
  albedo, normal, and translucency maps, a mirrored sprite sampling its
  cell mirrored with its normals' x negated, as `mirrorCells` does; then
  the badges, unlit. Wilting is the CSS filter's color matrix in the
  shader. Sway positions come from `sway.ts` on the CPU, as in Software,
  rather than a vertex shader, so both tiers move identically; the cost is
  a small instance upload per frame. Sampling sprites with a LOD bias of
  −0.75 matches Canvas's high-quality downscale, which trilinear mipmaps
  alone left visibly softer. With both the landscape and the plants on
  the GPU the worker lights nothing for the hillside, and the scene shows
  the requested light at once (`useShownLight`); a lost plant context
  hands the plants to Software, which asks the worker for sprites again,
  and takes them back on restore (the context lifecycle is shared,
  `src/ui/scene/useGpu.ts`). Static and the focus view still use relit
  sprites. **Verified**: in headless Chromium and on the Surface Pro's HD
  4000, the two tiers' pictures, compared over 8×8 blocks where plants are
  drawn and with motion reduced, differ at most by 5.4, 4.2, and 7.8 of
  255 levels at sunrise, full moon, and noon; knots sit under their hit
  targets, the hovered plant is outlined in cyan, sway leaves hit targets
  still, and a lost context hands over both ways, all with the GPU drawing
  the plants (`tests/e2e/botanical.spec.ts`, `garden-scene.spec.ts`).
  **Measured** on the Surface Pro (visible Chromium, HD 4000, 1920×1080,
  percent of one core): looping the day, the scene repaints 56.9 times a
  second with the GPU (every display frame) against 2.5 in Software, at
  204% against 248%; at rest with 8 plants swaying, 52% against 83%; with
  64 plants, 115% against 160%; Static 2–3%.
- **Step 4, GPU tier: the frame-time probe** (2026-09-30). Each GPU canvas
  times its first frames from the first draw call until the GPU has
  finished them (a one-pixel read back), skipping two for warm-up and
  timing six, then stops, so later frames never wait. The verdict
  (`gpuVerdict`, pure and tested) adds the landscape's median to the
  plants' (a frame while the light moves draws both) once three plant
  frames are in, against half a frame at the 15 fps cap, about 33 ms.
  Too slow, and Auto draws with Software for the rest of the visit; GPU
  chosen by hand stays, the viewer's call. The verdict is on the root
  element (`data-gpu-probe`). The sway probe still stops sway in either
  tier. **Verified** in the browser tests by passing SwiftShader off as
  an HD 4000 and slowing each timed frame to 45 ms: Auto takes the GPU,
  the probe finds it slow, and the whole scene moves to Software; GPU by
  hand stays. **Measured** on the Surface Pro's HD 4000, Auto keeps the
  GPU: 13.5 ms with 8 plants, 18.1 ms with 64, 24.4 ms while looping the
  day. **Step 4 is done**, bar the reviews below. **Open**: the frame
  rate, still 15 frames a second in both tiers (P2-E); measurements on
  the dedicated monitor and in a non-16:9 window ("Verification").
- **Step 5, weather** (2026-10-01). Live conditions come from the
  service ([ADR 0020](0020-weather-provider.md)); the `WeatherState`
  above is `src/environment/weather-effects.ts`, pure and unit-tested, and
  eleven developer previews (clear to thunderstorm, sleet, snow, high
  wind) pass through it like live weather, labelled "Weather preview".
  Live weather shows only with the live sky; a chosen time has none.
  - *Light*: cloud and fog leave 12% to 100% of the direct Sun and Moon
    (20% under a dry overcast; shadows go below 35%), greys the sky toward its own brightness, darker in
    rain, hides stars, and fog and rain thicken the haze. The result is an
    ordinary `LightingState`, so both tiers relight the art for it with no
    other change.
  - *Clouds*: a seeded field of 14 clouds of 12 to 19 soft elliptical
    puffs, the first `cover` share shown (so more cover only adds
    clouds), with a stratus sheet closing over the sky past half cover;
    they drift downwind by the minute, never per frame. They are a
    Canvas 2D raster (`src/ui/scene/weather-sky.ts`) that Software draws
    and the GPU tier uploads as a texture, so the skies match.
  - *Rainbow*, from optics (maintainer request, 2026-10-01;
    `src/environment/rainbow.ts`): rays traced through a spherical water
    drop at 77 wavelengths, with the refractive index of water (Daimon and
    Masumura, 2007), Snell's law, and Fresnel losses for each polarisation
    through one internal reflection (primary) or two (secondary), collected
    by angle from the antisolar point per unit solid angle, blurred by the
    Sun's disc (0.53°) and by diffraction from millimetre drops, and
    coloured with the CIE 1931 functions. The profile shows the primary
    bow (violet 40.6° to red 42.5°), the secondary (red 50.2° to violet
    53.6°, at 14% of the primary's luminance), Alexander's dark band, and
    the brighter sky inside the primary. Each pixel of the scene shows
    the profile at its angle from the antisolar point, which the bow
    circles, so its place and size follow from the Sun: centred opposite
    it (the opposite direction placed by `project`, like the Sun:
    `LightingState.antisolar`), its top 42° less the Sun's altitude above
    the horizon. Two corrections from the maintainer's review: the
    panorama spreads the sky wider across than up (at first about 1.6
    times), which drew the bow as a wide oval, so its angles are measured the same way in every
    direction (`rainbowAngle`) and it is round; and at the sky's scale it
    looked small and showed its lower half over the ridges, since the
    landscape is not at its true depth. A bow in rain stands on the
    ground, so its lower half is never seen: it stands on a ground line
    at the lowest point of the hill's crest (`RAINBOW_GROUND`, hidden by
    the hill from edge to edge), its centre the Sun's altitude below that
    line, and its scale (`RAINBOW_SCALE`, about 2.1 times the sky's) keeps
    its top at the true height for every Sun altitude. Nothing is drawn
    below the ground line. Past 54° of Sun the secondary fades out over
    ten degrees. It is light the rain sends back, so it is added to the
    scene (Canvas `lighter`, GPU `ONE, ONE`), tinted by the
    sunlight's colour: red at sunset. It appears when sunlight falls on
    rain: liquid drops, the Sun above the horizon (and below 64°, beyond
    which even the secondary sinks out of view), and gaps in the cloud;
    its strength follows the direct light and the gaps. In front of the
    ridge and behind the hill. Described as inferred from the
    forecast, never observed. The profile takes 0.13 s once; the raster,
    at most 960 pixels wide and scaled up, 35–50 ms on the Surface Pro,
    redrawn only when the Sun has moved about 0.1°.
  - *Precipitation and fog* (`src/ui/WeatherOverlay.tsx`): over the
    plants, under every icon and card, never a pointer target, and not in
    the focus view. Particle caps per 1920×1080 at full intensity: GPU
    900 rain, 700 sleet, 600 snow; Software 220, 180, 160. Each particle's
    place is `particleAt`, a function of its index and the time; the GPU
    tier computes it in the vertex shader with the same integer hash
    (`src/ui/scene/precipitation-gpu.ts`), one instanced draw and no
    per-particle CPU work. They move on the shared 15 fps clock, so the
    sway probe, hidden pages, Static, and reduced motion apply; Static
    and reduced motion show a still frame. Fog is a still band of haze.
  - *Wind*: the sway's amplitude follows the wind, 0.6 of the calm
    breeze in still air to at most 2.2 (about 7.5°), and slants rain and
    snow. Thunder darkens the cloud; there is no lightning, by default or
    otherwise.
  **Verified**: `tests/environment/weather-effects.test.ts`,
  `tests/ui/sway.test.ts`; browser tests in both tiers
  (`tests/e2e/weather.spec.ts`): live weather from a stand-in provider is
  drawn and described with its source, previews are labelled, heavy rain
  takes the colour out of the sky and the Sun off the hill, the tiers
  agree within 8 of 255 levels in the sky and on the hill, the rainbow
  appears only for sunlit showers; and every plant and icon stays
  reachable through a thunderstorm (`garden-scene.spec.ts`). **Measured**
  on the Surface Pro (visible Chromium, HD 4000, 1920×1080, 8 plants,
  noon, percent of one core): GPU 54% without weather, 56% in heavy rain
  (900 particles) or snow; Software 82% without, 89–90% in rain (220) or
  snow; Static 2% in rain. **Open**: review of the look on the dedicated
  monitor.
- **Step 6, quality presets** (2026-10-01). `src/ui/scene/quality.ts`: a
  Quality menu beside Drawing offers Low, Balanced, and High, remembered
  per browser like the tier. **High is the default** (maintainer
  decision, 2026-10-01: most devices keep up). A preset sets:

  | | Low | Balanced | High |
  | --- | --- | --- | --- |
  | Frames a second (sway, rain and snow, growth) | 10 | 15 | 30 |
  | Pixel-ratio cap of the garden's canvases | 1 | 2 | 2 |
  | Share of the particle caps, GPU / Software | 0.5 / 0.5 | 1 / 1 | 1.5 / 1 |
  | Sway | off | on | on |

  Balanced is the garden as it was. Low quarters a high-density
  display's pixels instead of halving the layers' resolution (the
  "Resolution" section's plan): one setting for every canvas in both
  tiers. Rain and snow listen to the clock apart from the plants
  (`listenFall`), so under Low the weather and the light still move and
  the plants rest. The frame-time probe judges frames against the
  preset's own rate: late at a rate above Balanced's, or busy (the median
  script time of a frame past half the frame), the clock falls back to
  15 fps for the visit (`data-sway="stepped"`); late at 15 fps or below,
  the clock stops as before. Choosing a preset again clears both. The
  busy rule came from the browser tests: Software at 4K on the Surface
  Pro drew 30 frames a second nearly on time (inside the late limit)
  while leaving the page too little time to show a new sky preview within
  5 s; with it, every browser test passes there.
  The GPU tier's probe keeps its budget, half a frame at 15 fps, so the
  preset does not change which tier Auto takes.
  **Verified**: `tests/ui/quality.test.ts`, `tests/ui/sway.test.ts` (the
  probe at a preset's rate), `tests/environment/weather-effects.test.ts`
  (scaled caps); browser tests: Low stills the plants with hit targets in
  place and is remembered, Balanced sways again
  (`garden-scene.spec.ts`), and each preset's particle count on the GPU
  (`weather.spec.ts`). The top bar now wraps at every width, since the
  extra menu overflowed it at 1280 px.
  **Measured** on the Surface Pro (visible Chromium, HD 4000,
  1920×1080, device pixel ratio 1, 8 plants, noon, `QUALITIES=…
  npm run measure:garden`, percent of one core; ranges are repeat runs):

  | | Low | Balanced | High |
  | --- | --- | --- | --- |
  | GPU, no weather | 1% | 52–55% | 102–113% |
  | Software, no weather | 3% | 82% | 135% |
  | GPU, heavy rain | 32% (450) | 53% (900) | 87–101% (1,350) |
  | Software, heavy rain | 44% (110) | 95% (220) | 153% (220) |

  Static: 1%. High doubles the cost of Balanced here, and the Surface Pro
  kept 30 fps (the clock did not step down). No animated preset meets
  the section 12 budget of under 10% of the machine on this 2-core
  machine; Low without weather and Static do.
  **Found while measuring**: the GPU tier's frame-time probe is noisy on
  the HD 4000, on `main` too: the same 8 plants read 6–17 ms on some
  loads and 36–58 ms on others, and a slow reading moves Auto to
  Software for the visit, which at High costs more, not less. Measured
  rows above force the tier. **Open**: a steadier probe (more samples,
  or timing after the worker's first relight), the P2-E measurements on
  the dedicated monitor and at one non-16:9 viewport, and the 24-hour
  soak.

**Superseded by [ADR 0021](0021-grass-sprites.md)** (the three "Grass
wind" entries below record the first iteration: the hill's image warped
and lit in waves; the grass is now wind-bent tufts, and the landscape no
longer animates).

**Grass wind, 2026-10-02** (designed with Codex, reviewed and measured
here). The hill's grass sways with the live wind, in rolling waves that
pulse with it (`src/ui/scene/wind-field.ts`, pure, mirrored in GLSL):

- **One wind field** for grass and plants, in design pixels: two scales of
  smooth lattice noise carried downwind by an accumulated travel, so a new
  forecast changes the speed (35 + 12 px/s per m/s, to 12 m/s) without the
  waves jumping. A broader gust mask travels half again as fast and
  strengthens the patches it crosses; a slow pulse (11, 17, and 29 s)
  deepens with the wind, so in a gale the lulls fall to about a third of
  the gusts, and calm air keeps a steady breeze. Patches shrink and slow
  toward the crest, and are wider than tall on screen: a front about 2.6
  times longer across the wind than along it, foreshortened on the hill.
- **Plants** sample the field at their place on the hillside, so a gust
  crosses grass and plants together; each keeps its own seeded rhythm, and
  the sway stays within ±`SWAY_ANGLE`.
- **GPU**: while the grass moves, everything behind the hill, and the
  relit hill itself, are drawn once per change of light, weather, or size
  into two textures; a frame copies the one and leans the other's blades
  (only painted blade detail moves, up to 2.8 design pixels at the front,
  times the wind strength, and its alpha stays put, so the crest never
  moves), lightening the bent blades in daylight, in the rows the hill
  covers. At rest the landscape draws directly, as before.
- **Software** keeps its relit hill still and rolls only the light: a
  1/16-scale sheen clipped to the hill, from coordinates and a mask made on
  resize and a 128×128 noise table (2.5 ms a frame on the Surface Pro at
  1/12 scale, before it went to 1/16).

The landscape now draws on the sway clock, so it moves only when the
plants do: never in Low, Static, under reduced motion, on a hidden page, or
once the probe stops sway. Repainting the whole relit landscape every
frame was first tried and made a GPU browser test time out under software
WebGL; the cached textures restored its time (16.7 s, against 16.8 s
before). Surface Pro, 8 plants, percent of one core, `main` → grass wind,
same session: GPU Balanced 51–55 → 57–58, High 107–108 → 93–94; Software
Balanced 81–82 → 83, High 131–133 → 138. The GPU probe's verdicts on the
HD 4000 were noisy on both (slow at 85–142 ms in some runs, ok at 10–28 ms
in others), as noted under step 6. Unit tests cover bounds, travel in
either direction, gust patches moving, no jump on a speed change, deep
lulls, and CPU/GLSL parity (`tests/ui/wind-field.test.ts`); a browser test
checks that the grass moves on both tiers and returns exactly to rest
(`tests/e2e/weather.spec.ts`).

**Grass wind, visible on phones, 2026-10-02.** On the maintainer's phone
the first version read as static: at about half the design scale, a lean
of 2.8 design pixels and a 5% lift were lost. Both tiers now shape the
bend into crisp patches (smoothstep 0.05–0.5), lift bent grass by up to
about a third and darken upright grass between the waves by up to about a
fifth (scaled by the wind, and the lift by daylight), and the GPU leans
blades up to 6 design pixels at the front. The phone had also stopped
sway at High with no sign why: the view's note now says when the garden is
held still by reduced motion, or when the probe stepped sway down or
stopped it for the visit (`motionHold`, motion.ts); never for Static or
Low, which the viewer chose. Surface Pro, 8 plants, high wind, percent of
one core: GPU 59 (Balanced), 96 (High); Software 89, 140.

**Grass wind on phone GPUs, 2026-10-02.** On the maintainer's phone the
plants swayed but the grass's light patches still did not show, where the
same deployed page moved plainly in desktop Chromium and in phone
emulation (mean change between frames 4–7 levels on the hill, against
0.74 on the phone). The shader hashed its noise lattice in unsigned
integers, and fragment shaders default to medium integer precision, which
phone GPUs may implement in 16 bits. The lattice is now made once on the
CPU and uploaded as a 128×128 R32F texture (`WIND_LATTICE`), read with
`texelFetch` through a high-precision sampler: no integer arithmetic, and
the CPU and GPU read the very same values.

## Verification

- Unit tests: relighting on synthetic texels (facing and backlit light,
  translucency maps, alpha, mirrored cells, map corrections), when a relight
  is needed, lit stem colors, and the shipped art's checksums and sizes
  against the asset manifest (`tests/ui/relight.test.ts`).
- Unit tests: astronomy results against published reference cases
  (sunrise and sunset tables, moon phase dates, a high-latitude polar day and
  night), a check that the vendored files match their reviewed SHA-256, and
  `SceneDescription` stability (same inputs, same scene;
  `tests/ui/description.test.ts`).
- Browser tests force each tier with the View-menu override. In Chromium
  run with `--disable-gpu`, **Auto** must choose Canvas 2D. Both tiers must
  keep the existing graph-fidelity and hit-target tests passing unchanged.
- The screenshot matrix gains lighting (dawn, noon, dusk, night, polar day)
  and weather cases for each tier, as review evidence rather than pixel
  goldens (as in ADR 0015).
- Measurements at 1920×1080 on the dedicated monitor (integrated NVIDIA,
  4 GB) and on the reference machine (Surface Pro): CPU and GPU use while
  animating and while idle for GPU, Software, and Static, plus one
  non-16:9 viewport, recorded in this record before it is accepted.

## Consequences

- ADR 0005's rule is amended: WebGL is adopted because a feature (sun
  relighting) needs it, not because of a measured bottleneck. It remains
  optional and never the only path.
- Two drawing tiers are more code to maintain than one. The shared
  `SceneDescription`, a single lighting model, and one `shade` function for
  both tiers keep the difference to when pixels are shaded, not how.
- The software tier spends a fraction of a second of background CPU per
  relight, a few times a minute at most (measured below), and holds the
  decoded maps in the worker's memory.
- The art library roughly doubles in files (albedo and normals, layered
  backdrop). Generation stays reproducible through recorded prompts.
- No npm runtime dependency is added. One reviewed, pinned submodule
  (astronomy-engine, MIT) is bundled, with its notice and checksums.

## Maintainer answers (2026-09-27)

1. **Dedicated monitor**: integrated NVIDIA GPU with 4 GB of video memory.
   Target 1920×1080, adapting to other resolutions (see "Resolution").
2. **Astronomy**: use astronomy-engine unless licensing is a concern. It is
   MIT, with no concern found (see "Astronomy").
3. **Software-tier sway**: keep it (see "Software tier").

## On acceptance

Update roadmap section 3 ("Phase 2 drawing"), the P2-C, P2-D, and P2-E items
this changes, and the index in [README.md](README.md), together.
