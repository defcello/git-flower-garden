# 0015: Botanical art direction and Canvas/SVG renderer proof (P2-A)

- Status: Review candidate (awaiting maintainer visual and asset review)
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
- On the hillside, plots are placed on a landscape (up to eight). Larger
  gardens use the card layout with the same artwork.

## Review findings and fixes

| Finding | Fix |
| --- | --- |
| The unreviewed garden preview had become the default view, while the README said Technical remains the default. Four Phase 1 browser tests failed, and the "graph truth" test compared Canvas against Canvas instead of against the technical view | Technical is the default again; a viewer's choice is remembered in that browser (`localStorage`, failure-safe) |
| On the hillside, empty or unreadable repositories rendered as nothing at all, so a broken source was invisible (roadmap principle 4, clear freshness) | Health is shown without text: a repository with nothing to draw is a soil bed; an unhealthy source or unreachable remote has a marker stake with its state glyph; a last-known plant is desaturated. Names and status stay hover/focus/tap-only (see below) |
| The hover reveal was hard to read: names were cut to one or two letters (the card layout's `max-width` inside a 150 px plant), the name card covered the circular `+`, and on empty or unreadable plots a second placeholder card overlapped the status card | Name and status cards sit beside the `+` at full width (mirrored for plants near the right edge); the status card is the single card and carries the explanation ("no commits yet", or the error); placeholder text stays for assistive technology |
| The circular `+` shrank to 33–41 px with plant scaling (section 7 requires at least 44×44) | Counter-scaled to keep an effective 44 px target |
| Nine or more repositories wrapped around eight fixed positions and overlapped | The hillside is used only up to eight plots; beyond that, cards |
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
choice, a text-free unattended scene with names and status on hover and
focus, soil beds and marker stakes for empty and missing repositories, and
44 px focus targets on the hillside. Codex's
`tests/e2e/botanical.spec.ts` checks graph truth across all three renderers
(now against the technical view), selection and camera across switches,
coincident refs and worktrees, atlas-failure fallback, and the lighting and
viewport matrix. Codex also fixed a real P1-F bug: a changed `github` mapping
was not re-applied on config reload.

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
  the Phase 1 technical view. This was not measured in P1-E; ADR 0013 now
  records it as an open gap.
- **WebGL is not justified.** The measured cost is the SVG overlay's size, not
  compositing. The next steps are to cull off-screen rows from the overlay and
  draw labels in the Canvas layer, then re-measure on the roadmap's baseline
  hardware (P2-B/P2-E).

## Open for the maintainer

1. **Visual direction:** the P2-A exit gate. Look at the demo (`node dist/cli.js
   demo`, then View → Garden preview) on the intended monitor.
2. **Generated artwork and licensing.** Both images come from an image model.
   The manifest labels them "MIT (project distribution license)" while
   disclaiming copyright in generated output. Whether to ship generated images,
   and how to state their terms, is a legal and policy decision I have not made
   on your behalf. The roadmap requires "assets can legally ship" before P2-A
   exits.
3. **Native 4K and real night art.** The 4K study upscales a 1672×941
   backdrop, and night is a darkened daytime image. The roadmap item asks for
   day, dawn/dusk, and night examples at 1080p and 4K; that item stays open.
