# 0023: Hillside layout computed for the garden's size, X first

- Status: Proposed (draft for maintainer review)
- Date: 2026-10-03
- Roadmap: section 7 (garden-renderer hillside), section 10 (P2-C, "Re-choose
  the 64 hillside growth points")
- Supersedes: the fixed 64-position table of
  [ADR 0015](0015-botanical-renderer-proof.md) ("64 fixed bush positions",
  `scripts/hillside-slots.ts`)

## Context

The hillside had 64 fixed positions (8 rows × 8 columns). A garden of `n`
repositories was spread over about √n of those rows. With 5 repositories,
for example, the plants stood in two rows of 2 and 3, so back plants stood
behind front ones. The Pages demo showed only about five of eight plants
reading as separate (roadmap P2-C).

The maintainer's direction (2026-10-03): plants evenly spaced on the hill,
with some X and Y randomness so the pattern isn't too regular, and with
**priority on X distribution**, so plants don't overlap unless the number of
repositories requires it.

## Decision

`hillsideLayout(count)` in `src/ui/hillside.ts` computes the positions. The
layout for a given count is seeded and is the same every time.

- **Columns first.** Up to `COLUMN_LIMIT` plants (32), each plant gets its
  own column. The columns are evenly spaced across 84 % of the hill's width
  and read left to right in configuration order. X jitter is up to a
  quarter of a column and at most 2.5 % of the width. It is limited so that
  neighboring columns stay at least 2.5 % apart, which is 48 px at 1920 px,
  wider than a 44 px icon.
- **Depth from footprint.** A front plant (scale 1) with its flowers is
  about 7.3 % of the width (140 of 1920 design pixels; the demo's plants are
  48–104 px of graph width plus flowers). Plants in the same depth band are
  `bands` columns apart, with `bands = ceil(7.3 / spacing)`. That gives one
  band up to 12 plants, two up to 24, and three up to 32. Columns alternate
  between bands, so neighbors zigzag back and front. With one band, depth
  wanders across the middle of the hill (±32 %). With several, it wanders
  within each band (±25 %).
- **Rows beyond 32.** Staggered rows of up to 11 plants, back to front. All
  rows share one lattice, with odd rows shifted by half a column, so plants
  in adjacent rows never line up. Shorter rows spread over the lattice.
  Jitter is small (5 % of a column in X, 12 % of a row in depth), because
  44 px icons at 64 plants leave little room.
- **Depth to screen** is unchanged from the table generator: part
  perspective and part even spacing below the crest, with scale `0.45 / (1 −
  0.55·depth)`. The top tenth of the depth range is kept clear of the crest.
- The hill's crest profile moves from the retired script into `hillside.ts`.
  `HILLSIDE_SLOTS`, `hillsideSlots()`, and `scripts/hillside-slots.ts` are
  removed. `HILLSIDE_CAPACITY` (64) stays the point at which gardens switch
  to cards.

## Consequences

- Up to 12 repositories, no plant stands in front of another, at any depth.
  Up to 32, plants that don't clear each other's footprint are in different
  depth bands.
- Positions still depend on the count, so adding a repository moves others,
  as before. Identities and order never change.
- The painted hill has small pale and dark specks. The grass check now
  requires most texels within half a percent of a base to be grass, instead
  of the single texel under it. A computed layout can land on a speck, and
  a plant stands on the patch, not on the speck.

## Verification

`tests/ui/hillside.test.ts` checks every count from 1 to 64:

- every base, and the ground just above it, is on the relit hill layer's
  grass;
- nearer plants (lower on the visible hill) are never smaller;
- no two 44 px focus icons overlap at 1920×1080, 2560×1440, 3840×2160, or
  2560×1080 (minimum 46.7 px at 1080p);
- up to the column limit, X increases in configuration order with at least
  44 px between neighbors;
- up to 12 plants, every pair clears a footprint; up to 32, pairs that don't
  are in different bands;
- gardens are centered and span the hill, a single plant stands near the
  middle, and gaps and depths vary (not a grid).

`tests/e2e/garden-scene.spec.ts` checks that plants and icons are drawn
where the layout places them (5 and 64 plants) and that all 64 icons are
reachable.
