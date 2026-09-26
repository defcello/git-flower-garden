/**
 * Exact selection of required common-ancestor anchors (roadmap section 4.3,
 * ADR 0003).
 *
 * Given branch-head commits H, a commit v is required when it is a best
 * (maximal) common ancestor of some subset S of H with |S| >= 2. With D(v) the
 * set of heads descended from v (including v itself when v is a head):
 *
 *   v is required  <=>  |D(v)| >= 2 and no immediate child c has D(c) = D(v).
 *
 * (=>) If v is best for S then S ⊆ D(v). A child c with D(c) = D(v) would be a
 * common ancestor of S strictly newer than v, contradicting maximality.
 * (<=) Take S = D(v). Any newer common ancestor w of S descends from v, so
 * D(w) ⊆ D(v); being common to S also gives D(w) ⊇ D(v). The child c of v on
 * the path to w then has D(w) ⊆ D(c) ⊆ D(v), so D(c) = D(v).
 *
 * Because D(c) ⊆ D(v) for every child c, "D(c) = D(v)" reduces to comparing
 * set sizes. The selector propagates D as bitsets from children to parents in
 * one topological pass: O((V + E) * ceil(H / 32)) time and
 * O(V * ceil(H / 32)) words of bitset memory.
 *
 * This is the P0-B prototype. tests/core/ancestor-anchors.test.ts checks it
 * against an independent exhaustive oracle and against `git merge-base`.
 */

/** Ordered parent OIDs by commit OID. Parents absent from the map are treated as history boundaries. */
export type ParentMap = ReadonlyMap<string, readonly string[]>;

export interface AncestorAnchor {
  oid: string;
  /**
   * Distinct head commits descended from this anchor: the largest head subset
   * for which it is a best common ancestor. Sorted.
   */
  heads: readonly string[];
}

/**
 * Return every best common ancestor of every subset of two or more distinct
 * heads, sorted by OID. Heads may repeat (several refs on one commit).
 */
export function selectAncestorAnchors(
  parents: ParentMap,
  heads: Iterable<string>,
): AncestorAnchor[] {
  const headOids = [...new Set(heads)].sort();
  for (const head of headOids) {
    if (!parents.has(head))
      throw new Error(`Head ${head} is not in the commit graph`);
  }
  if (headOids.length < 2) return [];

  // Index commits reachable from the heads. Only these can be anchors.
  const index = new Map<string, number>();
  const oids: string[] = [];
  const stack = [...headOids];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (index.has(oid)) continue;
    index.set(oid, oids.length);
    oids.push(oid);
    for (const parent of parents.get(oid) ?? []) {
      if (parents.has(parent) && !index.has(parent)) stack.push(parent);
    }
  }
  const count = oids.length;

  // Parent adjacency in compressed form, and each commit's child-edge count.
  const parentStart = new Int32Array(count + 1);
  const parentList: number[] = [];
  const pendingChildren = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    parentStart[v] = parentList.length;
    for (const parent of parents.get(oids[v] as string) ?? []) {
      const p = index.get(parent);
      if (p === undefined) continue; // history boundary
      parentList.push(p);
      pendingChildren[p] = (pendingChildren[p] as number) + 1;
    }
  }
  parentStart[count] = parentList.length;

  const words = Math.ceil(headOids.length / 32);
  const descendants = new Uint32Array(count * words);
  headOids.forEach((head, bit) => {
    const v = index.get(head) as number;
    const word = v * words + (bit >>> 5);
    descendants[word] = (descendants[word] as number) | (1 << (bit & 31));
  });
  const maxChildSize = new Int32Array(count);

  // Kahn's algorithm over child edges: a commit is finalized only after all
  // of its children have contributed their descendant sets.
  const ready: number[] = [];
  for (let v = 0; v < count; v++) if (pendingChildren[v] === 0) ready.push(v);

  const anchors: AncestorAnchor[] = [];
  let finalized = 0;
  while (ready.length > 0) {
    const v = ready.pop() as number;
    finalized++;
    const base = v * words;
    let size = 0;
    for (let w = 0; w < words; w++)
      size += popcount(descendants[base + w] as number);

    if (size >= 2 && (maxChildSize[v] as number) < size) {
      anchors.push({
        oid: oids[v] as string,
        heads: headsOf(descendants, base, words, headOids),
      });
    }

    for (
      let e = parentStart[v] as number;
      e < (parentStart[v + 1] as number);
      e++
    ) {
      const p = parentList[e] as number;
      const parentBase = p * words;
      for (let w = 0; w < words; w++) {
        descendants[parentBase + w] =
          (descendants[parentBase + w] as number) |
          (descendants[base + w] as number);
      }
      if (size > (maxChildSize[p] as number)) maxChildSize[p] = size;
      pendingChildren[p] = (pendingChildren[p] as number) - 1;
      if (pendingChildren[p] === 0) ready.push(p);
    }
  }
  if (finalized !== count) {
    throw new Error(
      "Commit graph contains a cycle; refusing to select ancestors",
    );
  }

  return anchors.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
}

function headsOf(
  bits: Uint32Array,
  base: number,
  words: number,
  headOids: readonly string[],
): string[] {
  const result: string[] = [];
  for (let w = 0; w < words; w++) {
    let word = bits[base + w] as number;
    while (word !== 0) {
      const low = word & -word;
      result.push(headOids[w * 32 + 31 - Math.clz32(low)] as string);
      word ^= low;
    }
  }
  return result;
}

function popcount(x: number): number {
  let n = x - ((x >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
