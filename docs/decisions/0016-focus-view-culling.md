# 0016: Focus-view culling and level of detail

- Status: Accepted
- Date: 2026-09-27
- Roadmap: sections 12 (interaction target), 10 (P2-A exit budget)

## Context

The P2-A review measured about 0.2–0.4 s per zoom step for a focused
2,000-commit graph in every renderer, against the roadmap target of input
response ≤ 100 ms and ≥ 30 fps pan/zoom ([ADR 0015](0015-botanical-renderer-proof.md)).
React was already skipping unchanged marks, because camera changes only
replace the enclosing transform. So the cost was the browser repainting every
commit, including its text, on each camera change. The canvas compositor also
reallocated its backing store and re-parsed every stem path on every frame.

The maintainer asked for a reasonable improvement with real numbers rather
than a hard target on this hardware: the reference machine is an old Surface
Pro (2 cores).

## Decision

- **Cull by rows.** The focus view renders only marks whose vertical extent
  meets a window around the visible range. Edges and tails are tested by
  their endpoints, and commits by their 30 px hit row. The window is snapped
  to power-of-two chunks at least a viewport tall and padded by a chunk on
  each side. Small pans and zoom steps keep the same window, so the memoized
  marks are reused and only the transform changes. Both art compositors cull
  by the same window.
- **Level of detail.** Below 0.5× zoom, where 12 px commit text would be
  under 6 px, commit text is not drawn. Commit text is also available through
  hover, details, and the accessible commit list.
- **Canvas hygiene.** The backing store is resized only when its size changes
  (otherwise it is cleared), and stem paths are parsed once per scene.
- The garden overview is unchanged: its plots are small and fully visible.

Horizontal culling was not added. A real selection is one row per commit, so
it is tall, not wide.

## Evidence

`tests/e2e/botanical.spec.ts`, 1920×1080, Edge, on the reference laptop;
zoom click to the second animation frame (4 warmups, 20 samples). These are
medians, with p95 in parentheses.

**Tall history** (the realistic shape: 2,000 commits, one per row). The fitted
zoom is 0.3.

| Renderer | Before, fitted | After, fitted | Before, readable (≥ 1×) | After, readable |
| --- | --- | --- | --- | --- |
| Technical | 212 (352) ms | 33 (35–69) ms | 170 (205) ms | 33 (35) ms |
| Garden · Canvas | 231 (274) ms | 33–34 (34–50) ms | 251 (602) ms | 33 (36) ms |
| Garden · SVG | 214 (292) ms | 34 (34–52) ms | 212 (297) ms | 33 (35–36) ms |

About 33 ms is the metric's floor: two frames at 60 Hz. Commits drawn fell
from 2,000 to 202 fitted and 77 at readable zoom.

**Tiled** (ADR 0015's benchmark: 200 copies laid out 20 across, so all 2,000
commits are on screen when fitted). Nothing can be culled; the gain comes
from dropping unreadable text.

| Renderer | Before (this run) | After |
| --- | --- | --- |
| Technical | 334 (1303) ms | 118 (289) ms |
| Garden · Canvas | 326 (489) ms | 161 (211) ms |
| Garden · SVG | 284 (1199) ms | 152 (235) ms |

Correctness: the tall test fetches the graph and checks that every commit
whose row is on screen is in the DOM, in all three renderers, after fit, six
drag-pans, and zooming to readable size. The check fails if the window is
cut short.

## Consequences

- On the realistic shape, the interaction target is met on the reference
  laptop at the 2,000-node envelope.
- The artificial wide case (2,000 commits all on screen at once) is still
  about 120–160 ms per zoom step. Drawing labels in the Canvas layer or a
  cheaper far-zoom glyph would help if a real workload ever looks like this.
- Tests that inspect focus-view marks see only nearby rows. The accessible
  commit list and details are unchanged and always cover every commit.
