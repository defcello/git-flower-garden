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

## Third iteration: even density, character, bending, and a wind preview (2026-10-03)

The maintainer's review of the second iteration: more convincing, then
four requests. Bare spots near the viewer, with the back no thinner than
it was; a little randomness per tuft, in size and in how late it answers
the wind, so tufts do not look rubber-stamped; no more shear, which
stretches the grass as if it were elastic, but a bend that keeps the
blades' length (pre-drawn lean frames from Codex, or procedural grass,
were offered as options); and wind controls in the demo, for direction,
speed (still air to a hurricane), and gusts, with the speed also driving
the clouds.

- **Density**: tufts grow closer together toward the viewer
  (`tuftSpacing`: 1.25 of the old spacing at the crest, 0.95 at the
  bottom edge, where it was about 1.3 throughout), so near rows have no
  bare ground between them. On the maintainer's second look, at 1.6 the
  back was too sparse, so it is now a little denser than in the second
  iteration. The GPU plants 8,986 tufts at Balanced and High (7,369
  before), Software 4,047 (3,336).
- **Character**: each tuft has its own size (0.75–1.25 of its depth's,
  from 0.8–1.2), height (`stretch`, 0.85–1.2 of its width), stiffness
  (`stiff`, 0.8–1.2 of the gusts' bend), and delay (`delay`, up to 0.15 s:
  it bends as the wave was a moment before, a little upwind). Neighbors
  still move as one (correlation above 0.9 a tuft apart; above 0.5 even
  at the largest difference in delay).
- **Bending**: a procedural bend of the painted tufts, chosen over new
  art. It needs no new generated images, so nothing more waits on
  redistribution approval, and it is continuous where frames would step.
  A tuft's stem bends along a circular arc, tips most (`tuftBend`): the
  point `v` up a stem of height `h` bent by `θ` lies `v(1 − cos φ)/φ`
  downwind and `v sin φ / φ` up, with `φ = θv/h`. Every point of a row
  moves as the stem does, so each upright blade becomes an arc of its own
  length. The pose is now an angle: `steadyBend` for the wind's speed
  (about 15° at 4 m/s, 60° in a hurricane) plus `gustBend` for its gusts
  (up to about 57°) times the wave, within −34° and 83°. The GPU draws
  each tuft as a strip of six rows bent in the vertex shader. Software
  draws it in horizontal bands, one per quarter radian of bend (up to
  six), each mapped so that its top and bottom rows land exactly where
  the arc puts them, so the bands meet. Far patches are drawn with the
  steady bend and shear only by the difference at the tip.
- **Direction**: the wind now blows across the ground, not only left or
  right (`WindField.windZ`, from the forecast's direction; the view faces
  south). Wave fronts run across the wind on the ground: a north wind
  rolls them up the hill, foreshortened (`FORESHORTEN`, 3), and tufts
  bending into the scene look shorter, their tips a little higher
  (`VIEW_TILT`).
- **Gusts**: `WindField.gust` (m/s above the mean) sets how far the waves
  bend the grass beyond its steady bend, how bright the sheen is, and how
  deep the lulls are. The forecast has no gusts, so they are taken as
  half the mean wind.
- **Wind preview**: a Wind control in the top bar: "Weather" (the
  forecast's or the weather preview's wind) or a compass point, with
  Speed (0–160 mph, named after the Beaufort scale) and Gusts (0–80 mph
  above the speed) sliders, labelled "Wind preview" in the art notice. It
  replaces the wind for the grass, the plants, the rain's slant, and the
  clouds.
- **Clouds**: they drift on the animation clock at 0.8 design pixels a
  second per m/s of wind (a breeze crosses the view in minutes, a
  hurricane in under a minute), as well as by the minute of the sky's
  clock as before; for now always left or right (direction comes with
  their later overhaul). The cloud raster covers their whole wrapping
  span and is drawn once, then placed at the drift in two copies, so
  moving them never redraws them. The landscape redraws only when they
  have moved half a canvas pixel. Software keeps the sky, ridge, and hill
  as layers at canvas size, so a redraw is a few copies. They hold still
  when the plants do.

- **Cost**: each tuft's fixed part of the wave (its place and the noise
  that bends the fronts) is computed once, at planting (`waveSite`), and
  what every tuft shares in a frame once per frame (`poseFrame`), so
  posing about 9,000 tufts costs less than 7,400 did. The GPU tier writes
  its instances into one array kept between frames.
- **Software smoothing**: tufts are drawn at well under their atlas
  size, and Canvas's default smoothing let thin, leaning blades alias
  into combs. Software now draws each tuft from the halved copy of the lit
  atlas nearest its size (`grassMip`, made once per light with
  high-quality smoothing), as the GPU's mipmaps do. High-quality smoothing
  on every draw looked the same but, rasterized on the CPU, slowed a 4K
  browser test past its limit.
- **Tier parity**: the tiers place every tuft alike, but light and filter
  the near grass's thin blades a little differently; with the near grass
  denser, larger, and bent, the worst 8-pixel block differs by up to
  about 27 of 255 levels at noon (12 before), so `botanical.spec.ts`
  allows 30, where it allowed 16. Neither the bands, the sizes, the
  heights, the bend, the spacing, nor the GPU's texture bias accounts for
  it alone.

Surface Pro, 8 plants, the high-wind preview, Balanced, percent of one
core, measured twice, interleaved with `main` to cancel drift over the
session (single runs varied by up to a third): GPU 53 and 53 against
`main`'s 67 and 67; Software 117 and 121 against 108 and 108; with the
smoothing above, GPU 55 and Software 121 (106 with high-quality smoothing
on every draw). Under
today's conditions, High stepped down to 15 frames a second on both
branches, on both tiers. Neither the clouds' motion (58 against 56 with
it held) nor Software's banding (107 against 109 with one band) costs
measurably.

## Verification

- Unit: `tests/ui/grass.test.ts` (planting on the crest, back to front,
  deterministic, larger and closer together toward the viewer, the whole
  width covered, the budget, each tuft's own size, height, stiffness, and
  delay; bending downwind, further in stronger wind and gusts, bounded,
  still in still air; waves moving neighbors together, travelling
  downwind, up the hill in a north wind; blades bent along arcs of their
  own length), `tests/ui/wind-field.test.ts`,
  `tests/ui/quality.test.ts`, the asset manifest's checksums
  (`tests/ui/relight.test.ts`), and the hillside slots against the new
  ground (`tests/ui/hillside.test.ts`).
- Browser: tufts on both tiers bend in the wind and return exactly to
  rest while the ground stays still; the wind preview is labelled and
  sets the wind, and the clouds hold in still air and under reduced
  motion and drift in a storm (`weather.spec.ts`); both tiers draw
  the plants and grass alike at rest (`botanical.spec.ts`); hover outlines,
  lost contexts, and all 64 icons as before (`garden-scene.spec.ts`).
