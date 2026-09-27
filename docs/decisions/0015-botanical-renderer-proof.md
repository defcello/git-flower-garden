# 0015: Botanical art direction and Canvas/SVG renderer proof (P2-A)

- Status: Accepted (maintainer sign-off 2026-09-27)
- Date: 2026-09-26
- Roadmap: sections 10 (P2-A), 7, 12

## What exists

Codex built this review candidate; I reviewed and corrected it (below).

- An original style sheet, a four-cell sprite atlas (two flower families, a
  leaf pair, a fruit), and a Blue Ridge backdrop. Both images were generated
  with an image model from the prompts in [docs/art/prompts.md](../art/prompts.md).
  Provenance is in [src/ui/public/asset-manifest.json](../../src/ui/public/asset-manifest.json).
- The View menu offers Technical (the default), Garden preview · Canvas, and
  Garden preview · SVG, plus four lighting studies (day, dawn, dusk, night).
  Lighting studies are CSS color grades of the one daytime backdrop, labeled as
  studies, not live conditions.
- Both garden compositors draw the same stems and sprites from one scene
  function (`src/ui/botanical.ts`) over the technical renderer's exact
  geometry. They keep the technical SVG as the interaction and text layer, so
  selection, details, focus, zoom, and the commit list behave identically.
  Stems only come from real or explicitly collapsed edges and tails, and flower
  families are seeded by ref identity, so a moved branch keeps its flower.
- On the hillside, up to 64 plants grow from fixed positions (see "Hillside
  at up to 64" below). Larger gardens use the card layout with the same
  artwork.

## Review findings and fixes

| Finding | Fix |
| --- | --- |
| The unreviewed garden preview had become the default view, while the README said Technical remains the default. Four Phase 1 browser tests failed, and the "graph truth" test compared Canvas against Canvas instead of against the technical view | Technical is the default again; a viewer's choice is remembered in that browser (`localStorage`, failure-safe) |
| On the hillside, empty or unreadable repositories rendered as nothing at all, so a broken source was invisible (roadmap principle 4, clear freshness) | Health is shown without text: a repository with no commits is a soil bed (only then, per the maintainer: otherwise the plant itself is enough); an unhealthy source or unreachable remote has a marker stake with its state glyph; a last-known plant is desaturated. Names and status stay hover/focus/tap-only (see below) |
| The hover reveal was hard to read: names were cut to one or two letters (the card layout's `max-width` inside a 150 px plant), the name card covered the circular `+`, and on empty or unreadable plots a second placeholder card overlapped the status card | Name and status cards sit beside the `+` at full width (mirrored for plants near the right edge); the status card is the single card and carries the explanation ("no commits yet", or the error); placeholder text stays for assistive technology |
| The circular `+` shrank to 33–41 px with plant scaling (section 7 requires at least 44×44) | Counter-scaled to keep an effective 44 px target |
| Nine or more repositories wrapped around eight fixed positions and overlapped | Superseded: the hillside now has 64 fixed positions, and dense overlap is intended (below) |
| The Canvas compositor reloaded the atlas on every pan and zoom frame (asynchronous, one new `Image` per frame) | The atlas is decoded once per page, and frames redraw synchronously |
| A lint error (non-null assertion) failed CI, masking the test failures above | Fixed |
| The npm package shipped the 2.3 MB review screenshot, and listed the manifest by its source path (the install rehearsal rejects sources in the package) | Only `docs/art/*.md` is packaged from `docs/`; the manifest moved to `src/ui/public/`, so the build copies it to `dist/ui/asset-manifest.json`, served beside the artwork |
| ADR 0015 was referenced but missing | This record |

**Correction (2026-09-27).** The first version of this review (commit
`0cfc05a`) also treated the hover-only names and status as a defect and added
always-visible labels. That was wrong: the maintainer intends the unattended
garden view to read as an uncluttered natural scene. I had applied section 7's
"name and compact source status" line, written before the garden renderer
existed, to the botanical overview. The labels are reverted; section 7 now
states that the technical renderer shows names and status always, and the
garden renderer only on hover, focus, or tap, with non-text health cues.

`tests/e2e/garden-scene.spec.ts` covers the technical default and remembered
choice, a text-free unattended scene, a soil bed for the empty repository
and a marker stake alone for the missing one, and the 64-position hillside (below). Codex's
`tests/e2e/botanical.spec.ts` checks graph truth across all three renderers
(now against the technical view), selection and camera across switches,
coincident refs and worktrees, atlas-failure fallback, and the lighting and
viewport matrix. Codex also fixed a real P1-F bug: a changed `github` mapping
was not re-applied on config reload.

## Hillside at up to 64 (maintainer design, 2026-09-27)

The maintainer asked for dense planting: overlap is fine because focus view
isolates one plant. The design, now in roadmap section 7:

- **64 fixed bush positions** in `src/ui/hillside.ts`: eight rows back to
  front, eight plants each, with a half-column stagger and a small fixed
  jitter. Rows are part perspective, part even spacing, following the hill's
  curve; plants scale from 0.45 (back) to 1.0 (front). The table is literal
  data; `scripts/hillside-slots.ts` only records how it was made. Pure
  perspective was rejected: it packs the back rows about 11 px apart, too
  tight for 44 px icons.
- **64 fixed icon positions**, one per bush, at the bush's base. Icons sit
  above every plant. At 1920×1080 the closest pair is 53.7 px apart
  (max of |dx|, |dy|), so no two 44 px targets overlap there or at any larger
  size. Below 1080p they can overlap, and the topmost icon wins.
- **Even spreading:** n repositories are split over round(√n) evenly spaced
  rows (more if needed), and each row over evenly spaced columns, in
  configuration order. Positions depend on n, so adding a repository can
  move plants; ids and order are stable.
- **Hover:** icons, names, and status are hidden until the plant or its
  icon is hovered or keyboard-focused. That plant alone gets a cyan outline
  that follows its silhouette. Clicking the icon or any part of the plant
  focuses it; commit tooltips and details belong to focus view.
- **The scene is the viewport.** The backdrop is a fixed `cover`
  background, so the scene is fixed to the viewport too. Before this, the
  sticky top bar pushed plants 56 px below where the art put them.

Evidence:

- `tests/ui/hillside.test.ts` decodes the backdrop PNG itself and checks
  that every base, and the pixels just above it, are grass. That is checked
  at 16:9, the worst case for a center-bottom `cover` backdrop: wider
  screens crop sky, taller ones crop the lower hill edges. It also checks
  that rows recede, that icons never overlap at 1080p, 1440p, 4K, or
  ultrawide, and that the spreading is distinct, ordered, centered, and
  balanced for every n from 1 to 64. By the same measure, two of Codex's
  original eight positions (x 65 %, y 64 % and x 84 %, y 71 %) were above
  the crest, in the forest.
- `tests/e2e/garden-scene.spec.ts` runs gardens of 5 and 64 at 1920×1080.
  Each plant grows from its slot (within 2 px). At 64, each icon is
  individually hovered and outlines exactly its own plant. Icon clicks and
  plant clicks, back and front, focus the right repository. Keyboard focus
  reveals and Enter focuses. More than 64 uses cards.

Fixed along the way:

- Focusing an empty repository showed no `−` control in any renderer. The
  fallback only covered a missing graph, not an empty one.
- The art-preview notice sat over the front-left plants and captured their
  icons. It now sits in the sky and takes no pointer input.
- Focus restored after a mouse return from focus view kept that plant lit,
  so hovering another lit two. Only keyboard focus (`:focus-visible`) now
  counts.

## Canvas versus SVG measurement

A 2,000-commit focused graph (the roadmap's selected-node envelope), 1920×1080,
measuring from a zoom click to the second animation frame (4 warmups, 20
samples). Measured on the 2-core Core m3 laptop (Edge) while an unrelated soak
test was also running, so the numbers are noisy. Two runs:

| Renderer | Median | p95 |
| --- | --- | --- |
| Technical (SVG) | 217 / 398 ms | 483 / 1376 ms |
| Garden · Canvas | 374 / 406 ms | 744 / 477 ms |
| Garden · SVG | 345 / 264 ms | 591 / 471 ms |

Conclusions:

- **Canvas is not faster than SVG yet**, because the Canvas mode still draws
  the full technical SVG as its interaction and text layer. The artwork is not
  the bottleneck.
- **No renderer meets the roadmap's interaction target** (input response ≤ 100
  ms, ≥ 30 fps pan/zoom) at 2,000 visible commits on this machine, including
  the Phase 1 technical view. This was not measured in P1-E. Since resolved
  for realistic (tall) histories by row culling ([ADR 0016](0016-focus-view-culling.md)).
- **WebGL is not justified.** The measured cost is the SVG overlay's size, not
  compositing. Row culling (ADR 0016) addressed it; drawing labels in the
  Canvas layer remains an option for very wide graphs.

## Maintainer decisions (2026-09-27)

1. **Visual direction:** approved. This closes the P2-A exit gate.
2. **Generated artwork and licensing:** both images ship under the project's
   MIT license as they are, with provenance kept in the manifest and
   `docs/art/prompts.md`.
3. **Native 4K and real night art:** the lighting studies (CSS color grades of
   one daytime backdrop, upscaled for 4K) are accepted for P2-A. Native 4K and
   real night artwork move to the setting and sky work (P2-C, P2-D).
4. **Interaction at 2,000 commits:** the reference machine is a Surface Pro
   (2017, Core m3), about nine years old and usually doing other work
   concurrently, so some slack is expected there. A reasonable
   improvement with measured numbers is enough for now (see ADR 0016).
