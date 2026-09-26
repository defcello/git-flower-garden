# 0007: Ancestor selector prototype — correctness and cost evidence

- Status: Accepted (P0-B evidence for [ADR 0003](0003-best-common-ancestor-interpretation.md))
- Date: 2026-09-26
- Roadmap: sections 4.3, 8 (P0-B), 12

## Question

Does the bitset rule in roadmap section 4.3 select exactly the union of best
common ancestors over every subset of two or more branch heads, and is it cheap
enough to run on the roadmap's ordinary and stress workloads?

## What was built

| File | Role |
| --- | --- |
| `src/core/ancestor-anchors.ts` | Prototype selector. One topological pass from children to parents propagates `D(v)`, the set of heads descended from `v`, as a bitset. It selects `v` when `\|D(v)\| >= 2` and no child has an equal set. The proof is in the file header. |
| `tests/oracle/best-common-ancestors.ts` | Independent oracle, written from the specification and sharing no code with the selector: for every head subset, intersect the ancestor sets and keep the maximal elements. Exponential; up to 12 heads. |
| `tests/oracle/git-merge-bases.ts` | Second reference: Git itself. For every head subset, `git merge-base --all --octopus`, reduced with `--independent`. |
| `tests/oracle/random-dag.ts` | Seeded DAG generator covering roots, octopus merges, varied merge density and reach, and repeated or ancestral heads. |
| `tests/core/ancestor-anchors.test.ts` | Specified cases, the oracle property test, and the Git cross-check. |
| `scripts/bench-ancestors.ts` | Time and memory benchmark (`npm run bench:ancestors`). |

The selector also reports each anchor's head set `D(v)`: the largest head subset it
is a best base for. That becomes the node's inclusion reason in P1-B, and the
oracle checks it too.

## Correctness results

All of the following pass locally on Windows and in CI on Ubuntu, Windows, and
macOS:

- **Specified cases:** fewer than two heads; a simple fork; a head that is an
  ancestor of another head (the head is its own base); disconnected histories (no
  invented root); a criss-cross (two bases); a three-head case where the
  triple's base `r` is not the merge base of any pair; octopus merges; missing
  parents (history boundary); cycles and unknown heads rejected; 40 heads (more
  than one 32-bit word).
- **Oracle agreement:** 2,000 seeded random DAGs with 1–60 commits and 1–10
  heads. Anchors and head sets match exactly. At least 1,500 graphs have an
  anchor and at least 1,000 have several, so most graphs are not trivial.
- **Git agreement:** the selector matches `git merge-base` on the four demo
  fixtures (where it also matches the oracle) and on 12 random repositories of
  30 commits with 2–5 heads, built through `git fast-import`.
- **The tests catch real bugs:** each deliberate bug below made the oracle and
  Git tests fail:

  | Deliberate bug | Failing tests |
  | --- | --- |
  | Drop the "no child with an equal set" check | 7 |
  | Select only commits with exactly two descendant heads (pairwise only) | 4 |
  | Leave a head out of its own descendant set | 7 |

No disagreement between the selector, the oracle, and Git was found. **No
algorithm contradiction blocks product UI work.**

### Side finding: Git's octopus merge-base

Git's documentation does not say that `merge-base --all --octopus` results are
mutually independent, so the Git reference reduces them with `--independent`. A
probe of the obvious over-reporting shape on Git 2.55 returned only the correct
base, so the reduction is defensive. The product must not rely on Git for this
anyway: the roadmap forbids enumerating `2^H` subsets.

## Cost results

`npm run bench:ancestors`. Each case runs in a fresh process. Histories are a main
line with side branches (2% fork chance per commit, 3% merge chance, 70% of
merged branches deleted). Heads are main plus sampled side-branch tips.

Hardware: Intel Core m3-7Y30 (2 cores / 4 threads, 1.0 GHz base), 4 GB RAM,
Windows 10, Node 24.18.0. This is **well below** the roadmap's benchmark baseline
(4-core laptop, 16 GB), so treat these numbers as pessimistic.

| Case | Commits | Heads | Graph input MiB | Selector median ms (runs) | Bitsets MiB | Peak process RSS MiB | Anchors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ordinary (roadmap target) | 100,000 | 100 | 28 | 186 (5) | 2 | 126 | 167 |
| many heads | 100,000 | 1,000 | 28 | 262 (5) | 12 | 162 | 1,719 |
| long history | 1,000,000 | 100 | 276 | 2,467 (3) | 15 | 559 | 137 |
| stress (roadmap) | 1,000,000 | 1,000 | 275 | 3,518 (3) | 122 | 653 | 1,775 |

"Graph input" is the `Map<string, string[]>` of 40-character OIDs handed to the
selector, measured as retained heap. "Bitsets" is the computed size of the
descendant bitsets (`commits × ceil(heads / 32) × 4` bytes). Peak RSS covers the
whole process, including generating the graph.

Observations:

- The ordinary workload takes about 0.2 s per repository on slow hardware. That
  is well inside the roadmap's 30 s cold-indexing and 500 ms incremental targets.
  It leaves room for Git reads, which will probably dominate.
- Time grows roughly linearly with commits. Heads add less than predicted: 10×
  more heads cost 1.4× time, because string-keyed map work dominates bitset work
  at these sizes.
- Bitset memory scales as predicted and is modest (122 MiB at the stress case).
  Graph input with string OIDs costs more than the bitsets at 100 heads, and
  about twice as much at 1,000 heads.
- The stress case completes in about 3.5 s using about 650 MiB. It stays
  bounded, but it is not interactive. P1 must keep this off the UI path and show
  progress (roadmap section 12).

## Limits of this evidence

- The benchmark histories are synthetic. Real repositories have different
  fork/merge shapes. P1-E must benchmark real public repositories.
- Random-DAG agreement is strong evidence, not proof. The proof sketch in the
  selector header is the argument; the tests check the implementation.
- The prototype indexes by string OID and rebuilds its index on every call. P1-B
  should consider caching the indexed topology across refreshes (roadmap
  section 4.3) and releasing each commit's bitset once its parents have consumed
  it. Both should be measured first.

## Revisit

At P1-B, when the selector is integrated with real Git reads and reduced edges,
and at P1-E, on real repositories and the roadmap's baseline hardware.
