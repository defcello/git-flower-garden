# 0010: Quiet repositories and graph pipeline cost — P1-B evidence

- Status: Accepted (P1-B exit evidence)
- Date: 2026-09-26
- Roadmap: sections 4.4, 9 (P1-B), 12

## Quiet-repository behavior

When nothing is recent, a repository shows only its required skeleton: branch
heads, their best common ancestors, and worktree HEADs. Old history becomes
dashed edges with exact hidden counts (or "…" when more than one hidden path
exists) and "older history" tails. Height follows the retained topology, not
elapsed time or the number of hidden commits.

| View | Visible / reachable | Image |
| --- | --- | --- |
| `gardenTour`, Tuesday 2026-09-22 15:00 (active) | 10 / 16 | [garden-tour.svg](assets/garden-tour.svg) |
| `gardenTour`, Wednesday 2026-10-07 (quiet) | 5 / 16 | [garden-tour-quiet.svg](assets/garden-tour-quiet.svg) |
| `forkMerge`, Wednesday 2026-10-07 (quiet) | 2 / 6 | [fork-merge-quiet.svg](assets/fork-merge-quiet.svg) |

In the quiet `gardenTour`, the `v1.0` merge stays visible as the base of `main`
and `herbs`. Its hidden ancestry runs down both sides of the old fork, so the
edge is marked "multiple paths" instead of showing a count that would suggest
one line of commits.

Old tags stay searchable (`GET /api/repositories/<id>/tags?q=`).
`?reveal=<oid>` temporarily shows a tag's commit and splits the compressed
edges around it. In `tests/server/server.test.ts`, revealing `v0.9` turns the
4-commit hidden run into runs of 2 and 1.

## Pipeline cost on a long quiet history

`npm run bench:graph` builds three years of linear history (100,000 commits
through real Git; 1,000,000 in memory), one old side branch, and five recent
commits. It then times each stage the service runs. Hardware: Intel Core m3-7Y30
(2 cores / 4 threads), 4 GB RAM, Windows 10, Node 24.18.0, Git 2.55. This is
below the roadmap's baseline machine, so the numbers are pessimistic.

| Case | Commits | Stage | ms |
| --- | ---: | --- | ---: |
| real Git | 100,006 | (setup) fast-import fixture | 18,417 |
| real Git | 100,006 | readSnapshot (refs, worktrees, rev-list topology, re-check) | 2,564 |
| real Git | 100,006 | buildVisibleGraph | 722 |
| real Git | 100,006 | layoutGraph | 2 |
| real Git | 100,006 | readCommitDetails (visible only) | 87 |
| real Git | 100,006 | renderSvg | 2 |
| in memory | 1,000,006 | buildVisibleGraph | 6,551 |
| in memory | 1,000,006 | layoutGraph | 1 |

Result at both sizes: **7 visible commits, 8 rows, 2 lanes, 300 px tall**. The
collapsed edge counts are exact (66,666 and 33,333 hidden at 100k).

- A cold read plus selection of a 100k-commit repository takes about 3.3 s,
  well inside the roadmap's 30 s cold-indexing target.
- Layout and rendering depend on visible size only, so they stay at a few
  milliseconds.
- At a million commits, selection takes 6.5 s. The memoized hidden-region
  summaries allocate one small map per hidden commit, and the ancestor selector
  re-indexes the graph. That is acceptable for the stress case, where the
  roadmap asks for graceful progress rather than latency. It is not acceptable
  per request, so the service now caches the last graph, keyed by snapshot
  revision, window start, current minute, and reveal set. Optimizing selection
  (shared indexing; releasing summaries once consumed) is a measured P1-E
  candidate.

## Checklist mapping (P1-B)

| Roadmap item | Where |
| --- | --- |
| Business days with injectable clock and zone | `src/core/business-days.ts`; oracle tests ([ADR 0009](0009-visible-graph-and-static-svg.md)) |
| Indexing, exact merge-base union, mandatory set, reduced edges | `src/core/ancestor-anchors.ts`, `src/core/visible-graph.ts` |
| Inclusion reasons, completeness, old-tag lookup and reveal | `reasons`, `anchorFor`, `futureDated`, `boundary`; snapshot `completeness` in the graph API; `tags` and `reveal` API |
| Named cases: timestamp inversion, DST, weekends, custom weekdays, old heads, duplicate heads, disconnected, criss-cross, octopus, shallow | `tests/core/visible-graph.test.ts` ("named fixture cases"), `tests/core/business-days.test.ts`, `tests/git/readers.test.ts` |
| Reduced reachability proven on generated DAGs; mandatory nodes retained | Path-enumeration oracle on 1,500 DAGs ([ADR 0009](0009-visible-graph-and-static-svg.md)) |
| Long old history benchmark stays compact | This record |
