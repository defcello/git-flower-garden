/*
 * Exhaustive reference for required ancestor anchors, written directly from
 * the specification in roadmap section 4.3 and sharing no code or technique
 * with src/core/ancestor-anchors.ts:
 *
 *   for every subset S of distinct heads with |S| >= 2,
 *     C = intersection of Anc(h) for h in S      (Anc includes h itself)
 *     keep c in C unless another d in C has c as a proper ancestor
 *
 * Exponential in the number of heads; for small generated graphs only.
 */
import type { ParentMap } from "../../src/core/ancestor-anchors.ts";

export const ORACLE_MAX_HEADS = 12;

export function ancestorsOf(parents: ParentMap, oid: string): Set<string> {
  const seen = new Set<string>();
  const visit = (current: string): void => {
    if (seen.has(current) || !parents.has(current)) return;
    seen.add(current);
    for (const parent of parents.get(current) ?? []) visit(parent);
  };
  visit(oid);
  return seen;
}

/** Map each required anchor OID to the union of subsets it is best for. */
export function oracleAnchors(
  parents: ParentMap,
  heads: Iterable<string>,
): Map<string, Set<string>> {
  const distinct = [...new Set(heads)];
  if (distinct.length > ORACLE_MAX_HEADS) {
    throw new Error(`Oracle limited to ${String(ORACLE_MAX_HEADS)} heads`);
  }
  const ancestry = new Map(distinct.map((h) => [h, ancestorsOf(parents, h)]));
  const properAncestors = new Map<string, Set<string>>();
  const isProperAncestor = (a: string, d: string): boolean => {
    let set = properAncestors.get(d);
    if (!set) {
      set = ancestorsOf(parents, d);
      set.delete(d);
      properAncestors.set(d, set);
    }
    return set.has(a);
  };

  const result = new Map<string, Set<string>>();
  for (let mask = 1; mask < 1 << distinct.length; mask++) {
    const subset = distinct.filter((_, i) => (mask >> i) & 1);
    if (subset.length < 2) continue;
    let common: Set<string> | undefined;
    for (const head of subset) {
      const anc = ancestry.get(head) ?? new Set<string>();
      common = common
        ? new Set([...common].filter((c) => anc.has(c)))
        : new Set(anc);
    }
    const candidates = [...(common ?? [])];
    for (const c of candidates) {
      if (candidates.some((d) => d !== c && isProperAncestor(c, d))) continue;
      const reasons = result.get(c) ?? new Set<string>();
      for (const head of subset) reasons.add(head);
      result.set(c, reasons);
    }
  }
  return result;
}
