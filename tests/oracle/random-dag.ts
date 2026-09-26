/*
 * Seeded random commit DAGs for property tests and benchmarks. Commits are
 * created in order and may only name earlier commits as parents, so every
 * generated graph is acyclic by construction.
 */
import type { FixtureSpec } from "../../src/demo/builder.ts";

/** Small, fast, deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomDagOptions {
  commits: number;
  heads: number;
  /** Chance a non-first commit starts a new, unrelated history. */
  rootChance?: number;
  /** Chance of each extra parent beyond the first (so octopus merges occur). */
  mergeChance?: number;
  /** How far back a parent may reach, as a count of earlier commits. */
  reach?: number;
}

export interface RandomDag {
  /** Commit names in creation order, `c0`, `c1`, … */
  names: string[];
  parents: Map<string, string[]>;
  /** Head commit names; may repeat, as several branches can share a commit. */
  heads: string[];
}

export function randomDag(seed: number, options: RandomDagOptions): RandomDag {
  const random = seededRandom(seed);
  const pick = (n: number): number => Math.floor(random() * n);
  const rootChance = options.rootChance ?? 0.03;
  const mergeChance = options.mergeChance ?? 0.25;
  const reach = options.reach ?? 8;

  const names: string[] = [];
  const parents = new Map<string, string[]>();
  for (let i = 0; i < options.commits; i++) {
    const name = `c${String(i)}`;
    const chosen: string[] = [];
    if (i > 0 && random() >= rootChance) {
      const lowest = Math.max(0, i - reach);
      const choose = () => names[lowest + pick(i - lowest)] as string;
      chosen.push(choose());
      while (chosen.length < 4 && random() < mergeChance) {
        const extra = choose();
        if (!chosen.includes(extra)) chosen.push(extra);
      }
    }
    names.push(name);
    parents.set(name, chosen);
  }

  // Favor later commits as heads, like real branch tips, but allow any commit.
  const heads: string[] = [];
  for (let h = 0; h < options.heads; h++) {
    const skew = random() ** 0.5;
    heads.push(
      names[
        Math.min(names.length - 1, Math.floor(skew * names.length))
      ] as string,
    );
  }
  return { names, parents, heads };
}

/** Turn a random DAG into a fixture spec with one branch per head. */
export function dagToFixture(dag: RandomDag, description: string): FixtureSpec {
  const start = Date.parse("2026-09-01T00:00:00Z");
  return {
    description,
    commits: dag.names.map((name, i) => ({
      name,
      parents: dag.parents.get(name) ?? [],
      committed: new Date(start + i * 60_000)
        .toISOString()
        .replace(".000Z", "Z"),
    })),
    branches: Object.fromEntries(
      dag.heads.map((head, i) => [`head-${String(i)}`, head]),
    ),
    head: "head-0",
  };
}
