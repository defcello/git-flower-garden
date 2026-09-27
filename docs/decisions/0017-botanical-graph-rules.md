# 0017: Botanical graph rules: taper, depth, seeds, and growth (P2-B)

- Status: Accepted
- Date: 2026-09-27
- Roadmap: section 10 (P2-B)

## Decision

The garden renderers draw one scene (`src/ui/botanical.ts`), computed only
from the visible graph. The technical SVG always sits above it as the
interaction and text layer, so artwork can never change what is clicked,
selected, or read.

- **Stems** are procedural. Each edge is a filled outline along the same
  cubic curve as the technical edge. The centerline, and so both endpoints,
  is the edge's own (`edgeCurve`). Hidden history (collapsed edges and tails)
  is a segmented centerline, and missing history keeps its distinct boundary
  color.
- **Taper by branch flow.** Every tip contributes 1. A commit passes its flow
  down split evenly over its stems (visible parents and history tails), so
  flow is conserved:
  - A fork's branches are thinner than the stem they leave.
  - A merge's incoming continuations each carry a share, so the merged stem
    is wider than each of them.
  - The root carries everything.

  Width is 1.2 + 1.4·√flow + 0.8·(height fraction), clamped to 1.8–7 px, so
  plants are thicker lower down and a 200-branch merge is still only 7 px.
- **Depth at crossings.** Stems are drawn thinnest first, each over a pale
  halo 2.5 px wider, in a stable order (width, then identity). Where stems
  cross, the thinner one passes behind the thicker with a visible gap, so a
  crossing never reads as a junction.
- **Commits** are a knot on the stem (sized to the widest stem there) and a
  seeded leaf pair.
- **Seeds.** Leaf rotation and mirroring are seeded by the commit, a flower's
  family and tilt by its ref, and each fruit by its tag. None of these depend
  on position, so a refresh never reshuffles the artwork, and a moved branch
  head keeps its flower.
- **Refs and tags.** Up to three flowers per commit. Every tag has its own
  fruit, up to three per commit. The text layer and details always list every
  ref and tag.
- **Grounding.** A soft shadow sits under each lowest point: a commit with no
  visible parent, or the end of its history tail.
- **Growth** (`src/ui/transition.ts`, 700 ms, ease out), when a repository's
  graph changes:
  - New stems, knots, leaves, flowers, and fruit fade in, and sprites grow in.
  - A ref's flower glides from its old commit to its new one.
  - Removed history fades out beneath what remains.
  - Only the artwork moves; the interaction layer is at its final positions
    at once.
  - No animation on first load, when switching repositories, or with reduced
    motion (the OS preference or the app setting).
- **One pipeline, two compositors.** Canvas and SVG draw the same frame with
  the same culling (ADR 0016).

## Evidence

- `tests/render/botanical-rules.test.ts`:
  - flow conservation;
  - fork branches thinner, merged stems wider, thicker lower down, clamped
    for a 200-tip merge;
  - one stem per edge and tail, ending exactly at the edge's endpoints;
  - deterministic thinner-behind depth order;
  - seeds independent of position;
  - one fruit per tag;
  - transitions: they settle exactly on the new scene, grow new marks, glide
    a moved ref's flower, and fade removed history.
- `tests/e2e/botanical-fidelity.spec.ts` checks the P2-B exit over the whole
  demo fixture suite (fork/merge, old branch, three heads, criss-cross, garden
  tour, art proof):
  - The commits, text, edges, hidden-history badges, tails, boundaries, and
    worktree markers are identical in the technical, Canvas, and SVG views.
  - In both garden compositors, every commit with a ref is hit at its own
    mark, however the flowers, fruit, and leaves overlap it, and its details
    list every ref.
- Performance with the new art, tall 2,000-commit history, median zoom step:
  technical 33 ms, Canvas 33 ms, SVG about 50 ms (the filled outlines cost
  the SVG compositor about 17 ms; still under the 100 ms target).

## Consequences

- A merge of many lines is wide but bounded. Readability over faithful
  "mass" is deliberate.
- Growth animates only in the art layer, so tests and assistive technology
  see a static, final structure.
- The atlas still has one leaf and one fruit design; variation comes from
  seeded rotation and mirroring. More variants are an asset task, not a rule
  change.
