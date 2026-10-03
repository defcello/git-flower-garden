# 0021: Grass as wind-bent tufts over a plain ground layer

- Status: Proposed (draft for maintainer review)
- Date: 2026-10-02
- Roadmap: section 10 (P2-C, P2-D, P2-E)
- Amends: [ADR 0018](0018-two-tier-scene-renderer.md) ("Grass wind", its
  first iteration, is replaced)

## Context

The hill was one painted image. Its first wind (ADR 0018, "Grass wind",
PRs #13, #15, #17) warped that image and rolled light across it in waves:
the maintainer saw it on the phone and called it a good first iteration,
then asked for the next: grass sprites animated to match the wind's speed
and direction, instead of a still image distorted to look like wind.

The maintainer's choices (2026-10-02):

1. **Codex-painted tufts**, flat-lit and relit like the plants' sprites,
   rather than procedural blades or a spike comparing both.
2. **A new plain ground layer** under them, replacing the painted grass.
3. **Depth-sorted with the plants**: a tuft nearer than a plant's base is
   drawn over it; hit targets stay above everything (ADR 0005, 0015).

## Decision

### Art

- **Tufts**: one Codex image, four tufts in a 2×2 atlas (a short dense
  tuft, a tall loose one, a broad clump, and a seeding one), each growing
  from the bottom center of its cell; the prompt is in
  [docs/art/prompts.md](../art/prompts.md#grass-tufts-flat-lit-albedo).
  Codex's own normal and translucency maps for it did not line up with
  the blades (it says so itself), and thin blades need an exact fit, so
  both maps are derived by `scripts/grass-art.ts` instead, deterministic
  and with no model: normals with the relight spike's `deriveNormals`
  (each blade a rounded strip, with luminance detail), and translucency
  brightest at thin tips and edges, least at each tuft's foot.
- **Ground**: Codex repainted the hill as close-cropped turf, with the old
  hill as its layout reference. The script grades it darker, toward the
  shade at the tufts' feet (between tufts the ground reads as the depth
  of the grass, not as a lawn behind it), and gives it the old hill's
  crest as a clean alpha, so the crest, the hillside slots, and their test
  against the image do not move. Its normal map is the old hill's dome
  (that Codex map's X axis corrected, blurred until its blade streaks are
  gone) with the turf's fine detail; it is now in the standard convention,
  so the load-time X correction is gone.
- The raw Codex images are kept in `docs/art/grass/`; every file is in the
  asset manifest with its provenance. **Redistribution of the new
  generated art under the MIT license awaits the maintainer's approval**,
  as ADR 0015 recorded it for the first art.

### Planting and wind

`src/ui/scene/grass.ts`, pure and unit-tested:

- Tufts are planted in rows that follow the crest (`crest.ts`, generated
  from the ground's alpha), from about 12 design pixels at the crest to
  about 115 at the bottom edge, spaced in proportion to their size and
  thinned toward the crest, where the ground already reads as grass. Each
  strays almost a row in depth, so rows never show. Kind, mirroring, size,
  and flutter are seeded. The full field is 3,247 tufts; a preset plants a
  share of it (Low 0.5: 859; Balanced and High 0.75: 1,860), the same on
  both tiers, so falling back to Software never changes the meadow.
- A tuft leans by a shear about its base, shortened so its blades keep
  their length: steadily downwind with the wind's strength (sway.ts
  `windStrength`), further as a gust patch of the shared wind field
  (`wind-field.ts`, unchanged: patches carried downwind, a travelling gust
  mask, a pulse with deep lulls in strong wind) passes, springing back
  between, with a little seeded flutter. Within ±0.9. At rest (Low,
  Static, reduced motion, hidden page, the probe), each tuft holds the
  wind's steady lean.
- The plants sample the same field, so a gust crosses grass and plants
  together.

### Drawing

- **Both tiers** draw the grass on the plants' canvas, back to front,
  interleaved with the plants: each plant stands in front of the tufts
  that grow behind its base; the highlighted plant stands in front of all.
  The SVG compositor's plots draw their own plants, so there a canvas of
  grass alone lies under them.
- **GPU**: one instanced pass per run of tufts between two plants, sheared
  in the vertex shader and lit by the sprites' fragment shader from the
  grass maps; the lean is computed on the CPU per tuft per frame.
- **Software**: the worker relights the grass atlas (256-pixel cells) and
  a mirrored copy with the sprites. Near tufts are drawn one by one; far
  ones (under 44 design pixels), small and moving a few pixels, in patches
  of neighbors drawn once per light and leaning as one about their
  baseline, never straddling a plant's base.
- The landscape no longer animates: the first iteration's warp, sheen,
  and cached textures are removed, and with them the shader copy of the
  wind field.

## Consequences and measurements

Surface Pro (Core i5-3317U, HD 4000), 8 plants, the high-wind preview,
percent of one core (`npm run measure:garden`), against `main` before the
tufts measured the same day:

| | Low | Balanced | High |
| --- | --- | --- | --- |
| GPU, before | 1 | 51–55 | 107–108 |
| GPU, tufts | 1 | 57 | 96–103 |
| Software, before | 3 | 81–82 | 131–133 |
| Software, tufts | 4 | 102 | 175 (115 when the probe stepped it to 15 fps) |

The GPU tier, which Auto chooses on graphics hardware, costs about what it
did. **Software costs about a fifth of a core more at Balanced and up to
half a core more at High**: the grass covers much of the canvas, which
must now be redrawn every frame. Under headless software rendering, the
browser tests that run Software while the grass moves take longer (one
took 27 s of its 30). Options for the maintainer: accept it; plant fewer
tufts on every tier; let Software hold far tufts still; or let Software
draw the grass at half its frame rate.

## Second iteration: density and waves (2026-10-03)

The maintainer's review of the first tufts (#18): good, but sparser than
the painted hill they replaced, and moving semi-randomly per tuft instead
of in the waves the first iteration simulated. A tuft's lean was a gust
term (about ±0.12 of its height) plus its own flutter (about ±0.07), so
the shared field drowned in jitter; and the field itself, value noise
whose `2b − 1` rarely passes ±0.5, made weak blotches rather than waves.

- **Waves**: `waveShape` (wind-field.ts) is now fronts across the wind,
  one `WAVELENGTH` (320 design pixels; it divides the travel wrap) apart,
  carried downwind, bent ±3.5 radians by slow noise so they never run in
  straight bars, with a little finer texture, and strong only where a gust
  patch passes (15% elsewhere). The plants share it.
- **Coherence**: a tuft's lean is the steady push plus 0.45 of the wave
  at its base (times the wind's strength), with a trace of its own flutter
  (0.012). Neighbors lean almost as one (correlation above 0.9 a tuft's
  width apart); tufts half a wave apart do not; the pattern travels
  downwind (`tests/ui/grass.test.ts`).
- **Sheen**: as in the first iteration, the waves show as light: a tuft
  bent beyond its steady lean is paler (toward `SHEEN.color`, by up to 0.3,
  scaled by daylight), one standing up between the waves darker (by up to
  0.2). The GPU applies it per tuft in the grass's fragment shader;
  Software draws each tuft from the nearest of five sheen levels of the
  lit atlas, made once per light (patches too, at each level).
- **Density**: smaller tufts (10 to 88 design pixels), closer together,
  mostly slender kinds (round dense tufts read as blobs when small): the
  full field is 12,948 tufts. Both tiers draw only each tuft's own
  rectangle of its cell (`TUFT_RECT`), so the cells' transparent margins
  cost no fill.
- **Software plants fewer** (ADR 0018 allows a reduced software tier).
  The GPU plants 7,369 tufts at Balanced and High (about 1.5 screens of
  quads a frame); without a GPU the canvas is often filled on the CPU,
  where that many slowed the whole page (under headless Chromium, the
  time slider and hovering stalled and tests timed out). Software plants
  3,336 (0.67 screens, about what the first tufts took) at every preset,
  as the GPU does at Low, so the tiers are compared there. This reverses
  the first iteration's "the same field on both tiers".
- **Software patches** now hold the wind's steady lean and are used at
  rest too (copied as they are), lean only by the difference while
  moving, take every tuft under 60 design pixels, and draw each sheen
  level only when first needed; their cache no longer changes when a
  plant is hovered. Before that, each hover and each relight (each step of
  the time slider) redrew every far tuft five times.
- **Grass at night** goes as grey as the ground (`LAYERS.grass`: the
  sprites' light, but full night vision; the plants keep half their color
  because it carries Git meaning).

Surface Pro, 8 plants, high wind, percent of one core (Low / Balanced /
High): GPU 1 / 69 / 98, High at 30 frames a second; Software 2 / 103 /
176, as the first tufts (4 / 102 / 175). Before the quads were trimmed,
the HD 4000 could not keep High at 30; before Software's cap it cost
110 at Balanced. Under headless Chromium on this 2-core machine, one
browser test that drags the time slider through 35 relights takes 26–31
of its 30 seconds, as on `main` (27); on CI it takes 6–10.

## Verification

- Unit: `tests/ui/grass.test.ts` (planting on the crest, back to front,
  deterministic, larger toward the viewer, the whole width covered, the
  budget; leaning downwind, further in stronger wind, bounded, moving with
  the gusts; blades keeping their length), `tests/ui/wind-field.test.ts`,
  `tests/ui/quality.test.ts`, the asset manifest's checksums
  (`tests/ui/relight.test.ts`), and the hillside slots against the new
  ground (`tests/ui/hillside.test.ts`).
- Browser: tufts on both tiers bend in the wind and return exactly to
  rest while the ground stays still (`weather.spec.ts`); both tiers draw
  the plants and grass alike at rest (`botanical.spec.ts`); hover outlines,
  lost contexts, and all 64 icons as before (`garden-scene.spec.ts`).
