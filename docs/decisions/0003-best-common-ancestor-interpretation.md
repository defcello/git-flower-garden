# 0003: "Every common ancestor" means best common ancestors of every head subset

- Status: Accepted; prototype validated in P0-B ([0007](0007-ancestor-selector-evidence.md))
- Date: 2026-09-26
- Roadmap: sections 4.3, 4.4

## Context

The requirement is to keep "each common ancestor for each combination of branch
heads". Taken literally, every historical common ancestor of two heads is most of
the repository's history, which defeats the goal of short trees for quiet
repositories. Pairwise `git merge-base` answers are not enough either: criss-cross
merges produce several equally good bases, and plain `git merge-base A B C` does
not compute the common ancestors of all three heads.

## Decision

Let H be the distinct commits targeted by in-scope branch refs. The required
ancestor set is the union, over every subset S of H with at least two members, of
the **best** (maximal) common ancestors of S. That is the set that
`git merge-base --all --octopus` reports for S.

The intended exact algorithm propagates, from children toward parents, the bitset
`D(v)` of heads descended from each commit `v`, and selects `v` when
`|D(v)| >= 2` and no immediate child has the same set. It avoids enumerating all
`2^|H|` subsets. Roadmap section 4.3 gives the justification.

Heads that are also bases remain one node. Disconnected histories get no invented
common root.

## Evidence

[ADR 0007](0007-ancestor-selector-evidence.md) records the P0-B prototype
(`src/core/ancestor-anchors.ts`). It agrees with an independent exhaustive oracle
on 2,000 random DAGs and with `git merge-base` on the demo fixtures and on random
repositories. It also records time and memory at the roadmap's workload sizes.

The demo fixtures in `tests/fixtures/demo.ts` pin cases where this matters, and
`tests/fixtures/builder.test.ts` checks them against Git itself:

- `threeHeads`: `{main, right}` share `fork`, while every subset that includes
  `early` shares only the older `sprout`.
- `crissCross`: `main` and `side` have two best merge bases, `left1` and `right1`.

## Consequences

- User documentation must state this interpretation. It differs from both
  "pairwise merge bases" and "all common ancestors".
- The selector needs an independent exhaustive oracle over generated small DAGs;
  the proof sketch alone does not establish a correct implementation.
- Memory grows with commits × heads / word size; limits must be visible, never a
  silent fallback to pairwise heuristics.

## Revisit

In P0-B, if the bitset selector and the exhaustive oracle disagree on any
generated DAG, and at P1-E if measured cost exceeds the performance envelope.
