import type { FixtureSpec } from "./builder.ts";

/*
 * Deterministic demo repositories. Names, messages, and identities are
 * fictional. Recent dates fall in the week of Monday 2026-09-14 and Monday
 * 2026-09-21 (America/New_York, EDT) so business-day tests can pin a clock.
 */

/** A feature branch forks from main and is merged back; the branch still exists. */
export const forkMerge: FixtureSpec = {
  description:
    "Fork and merge: `trellis` forks from main and merges back with a two-parent merge.",
  commits: [
    {
      name: "root",
      message: "Plant the seed",
      committed: "2026-09-14T09:00:00-04:00",
    },
    {
      name: "trunk1",
      parents: ["root"],
      message: "Water the roots",
      committed: "2026-09-15T09:00:00-04:00",
    },
    {
      name: "feat1",
      parents: ["trunk1"],
      message: "Sketch the trellis",
      committed: "2026-09-16T09:00:00-04:00",
    },
    {
      name: "trunk2",
      parents: ["trunk1"],
      message: "Mulch the bed",
      committed: "2026-09-17T09:00:00-04:00",
    },
    {
      name: "feat2",
      parents: ["feat1"],
      message: "Build the trellis",
      committed: "2026-09-18T09:00:00-04:00",
    },
    {
      name: "merge",
      parents: ["trunk2", "feat2"],
      message:
        "Merge branch 'trellis'\n\nThe climbing roses have somewhere to go.",
      committed: "2026-09-21T09:00:00-04:00",
    },
  ],
  branches: { main: "merge", trellis: "feat2" },
  tags: { "v0.1.0": "trunk1" },
};

/**
 * Years of quiet linear history plus a long-abandoned branch. The old branch
 * head and its merge base with main must survive any recent-window cutoff.
 */
export const oldBranchHead: FixtureSpec = {
  description:
    "Old branch head: `archive/prototype` last moved in 2024 and forked from an old commit.",
  commits: [
    {
      name: "ancient1",
      message: "Clear the plot",
      committed: "2024-01-08T10:00:00-05:00",
    },
    {
      name: "ancient2",
      parents: ["ancient1"],
      message: "Test the soil",
      committed: "2024-02-12T10:00:00-05:00",
    },
    {
      name: "proto1",
      parents: ["ancient2"],
      message: "Try a rock garden",
      committed: "2024-03-11T10:00:00-04:00",
    },
    {
      name: "ancient3",
      parents: ["ancient2"],
      message: "Lay the path",
      committed: "2024-05-06T10:00:00-04:00",
    },
    {
      name: "ancient4",
      parents: ["ancient3"],
      message: "Edge the lawn",
      committed: "2024-09-09T10:00:00-04:00",
    },
    {
      name: "ancient5",
      parents: ["ancient4"],
      message: "Winterize",
      committed: "2025-11-17T10:00:00-05:00",
    },
    {
      name: "recent1",
      parents: ["ancient5"],
      message: "Prune the hedges",
      committed: "2026-09-18T14:00:00-04:00",
    },
    {
      name: "recent2",
      parents: ["recent1"],
      message: "Sow wildflowers",
      committed: "2026-09-21T11:00:00-04:00",
    },
  ],
  branches: { main: "recent2", "archive/prototype": "proto1" },
};

/**
 * Three heads whose best common ancestors differ by subset:
 * {left, right} -> fork; any subset including `early` -> sprout.
 */
export const threeHeads: FixtureSpec = {
  description:
    "Three heads: `left`/`right` share `fork`; `early` shares only the older `sprout`.",
  commits: [
    {
      name: "root",
      message: "Plant the seed",
      committed: "2026-09-14T09:00:00-04:00",
    },
    {
      name: "sprout",
      parents: ["root"],
      message: "First sprout",
      committed: "2026-09-15T09:00:00-04:00",
    },
    {
      name: "fork",
      parents: ["sprout"],
      message: "Second leaf",
      committed: "2026-09-16T09:00:00-04:00",
    },
    {
      name: "early1",
      parents: ["sprout"],
      message: "Early bloom",
      committed: "2026-09-17T09:00:00-04:00",
    },
    {
      name: "left1",
      parents: ["fork"],
      message: "Lean toward the sun",
      committed: "2026-09-18T09:00:00-04:00",
    },
    {
      name: "right1",
      parents: ["fork"],
      message: "Lean toward the fence",
      committed: "2026-09-21T09:00:00-04:00",
    },
  ],
  branches: { main: "left1", right: "right1", early: "early1" },
};

/**
 * Criss-cross merge: each branch merges the other's tip, so the two heads
 * have two equally good merge bases (`left1` and `right1`).
 */
export const crissCross: FixtureSpec = {
  description:
    "Criss-cross merge: `main` and `side` each merged the other, leaving two best merge bases.",
  commits: [
    {
      name: "base",
      message: "Plant the seed",
      committed: "2026-09-14T09:00:00-04:00",
    },
    {
      name: "left1",
      parents: ["base"],
      message: "Add tulips",
      committed: "2026-09-15T09:00:00-04:00",
    },
    {
      name: "right1",
      parents: ["base"],
      message: "Add daffodils",
      committed: "2026-09-15T10:00:00-04:00",
    },
    {
      name: "leftMerge",
      parents: ["left1", "right1"],
      message: "Merge branch 'side'",
      committed: "2026-09-16T09:00:00-04:00",
    },
    {
      name: "rightMerge",
      parents: ["right1", "left1"],
      message: "Merge branch 'main' into side",
      committed: "2026-09-16T10:00:00-04:00",
    },
    {
      name: "left2",
      parents: ["leftMerge"],
      message: "Edge the tulips",
      committed: "2026-09-17T09:00:00-04:00",
    },
    {
      name: "right2",
      parents: ["rightMerge"],
      message: "Edge the daffodils",
      committed: "2026-09-17T10:00:00-04:00",
    },
  ],
  branches: { main: "left2", side: "right2" },
};

/**
 * A tour of everything the technical view must show honestly: years of quiet
 * history compressed into one dashed edge, an old abandoned branch kept with
 * its base, a recent fork merged back, an open branch, an annotated release
 * tag, and an old tag that stays hidden. View it on Tuesday 2026-09-22.
 */
export const gardenTour: FixtureSpec = {
  description:
    "Garden tour: compressed old history, an old branch, a recent fork and merge, an open branch, tags.",
  commits: [
    {
      name: "a1",
      message: "Clear the plot",
      committed: "2024-01-08T10:00:00-05:00",
    },
    {
      name: "a2",
      parents: ["a1"],
      message: "Test the soil",
      committed: "2024-02-12T10:00:00-05:00",
    },
    {
      name: "rock1",
      parents: ["a2"],
      message: "Try a rock garden",
      committed: "2024-03-11T10:00:00-04:00",
    },
    {
      name: "rock2",
      parents: ["rock1"],
      message: "Add alpine plants",
      committed: "2024-03-12T10:00:00-04:00",
    },
    {
      name: "a3",
      parents: ["a2"],
      message: "Lay the path",
      committed: "2024-05-06T10:00:00-04:00",
    },
    {
      name: "a4",
      parents: ["a3"],
      message: "Edge the lawn",
      committed: "2024-09-09T10:00:00-04:00",
    },
    {
      name: "a5",
      parents: ["a4"],
      message: "Winterize",
      committed: "2025-11-17T10:00:00-05:00",
    },
    {
      name: "a6",
      parents: ["a5"],
      message: "Order bulbs",
      committed: "2026-09-10T10:00:00-04:00",
    },
    {
      name: "m1",
      parents: ["a6"],
      message: "Prune the hedges",
      committed: "2026-09-21T09:00:00-04:00",
    },
    {
      name: "t1",
      parents: ["m1"],
      message: "Sketch the trellis",
      committed: "2026-09-21T10:00:00-04:00",
    },
    {
      name: "m2",
      parents: ["m1"],
      message: "Mulch the beds",
      committed: "2026-09-21T11:00:00-04:00",
    },
    {
      name: "t2",
      parents: ["t1"],
      message: "Build the trellis",
      committed: "2026-09-21T13:00:00-04:00",
    },
    {
      name: "merge",
      parents: ["m2", "t2"],
      message: "Merge branch 'trellis'",
      committed: "2026-09-22T09:00:00-04:00",
    },
    {
      name: "h1",
      parents: ["merge"],
      message: "Start the herb spiral",
      committed: "2026-09-22T10:00:00-04:00",
    },
    {
      name: "h2",
      parents: ["h1"],
      message: 'Plant <basil> & "thyme"',
      committed: "2026-09-22T11:00:00-04:00",
    },
    {
      name: "m3",
      parents: ["merge"],
      message: "Water everything",
      committed: "2026-09-22T12:00:00-04:00",
    },
  ],
  branches: { main: "m3", herbs: "h2", "archive/rock-garden": "rock2" },
  tags: { "v0.9": "a4" },
  annotatedTags: {
    "v1.0": {
      target: "merge",
      message: "First bloom",
      tagged: "2026-09-22T09:30:00-04:00",
    },
  },
};

export const demoFixtures = {
  forkMerge,
  oldBranchHead,
  threeHeads,
  crissCross,
  gardenTour,
} as const;
export type DemoFixtureName = keyof typeof demoFixtures;

/** P2-A review scene: the tour plus coincident heads, without extra commits. */
export const artProof: FixtureSpec = {
  ...gardenTour,
  description:
    "Art proof: fork, merge, release fruit, coincident heads, and worktree marker.",
  branches: { ...gardenTour.branches, release: "m3", stable: "m3" },
};
