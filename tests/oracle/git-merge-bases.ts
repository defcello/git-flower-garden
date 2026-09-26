/*
 * Second, independent reference: ask Git itself. For each subset of two or
 * more heads, `git merge-base --all --octopus` returns the best common
 * ancestors. The documentation does not promise that octopus results are
 * mutually independent, so `--independent` defensively reduces multi-result
 * answers to the maximal set before taking the union. (A probe of the
 * obvious over-reporting shape on Git 2.55 showed no redundant results.)
 */
import { GitError, runGit } from "../../src/git/run-git.ts";

async function lines(dir: string, args: readonly string[]): Promise<string[]> {
  try {
    const out = await runGit(args, { cwd: dir });
    return out.split("\n").filter((line) => line.length > 0);
  } catch (error) {
    // merge-base exits 1 with no output when commits share no ancestor.
    if (error instanceof GitError && error.exitCode === 1) return [];
    throw error;
  }
}

export async function gitAnchors(
  dir: string,
  heads: Iterable<string>,
): Promise<Set<string>> {
  const distinct = [...new Set(heads)];
  const subsets: string[][] = [];
  for (let mask = 1; mask < 1 << distinct.length; mask++) {
    const subset = distinct.filter((_, i) => (mask >> i) & 1);
    if (subset.length >= 2) subsets.push(subset);
  }
  const results = await Promise.all(
    subsets.map(async (subset) => {
      const bases = await lines(dir, [
        "merge-base",
        "--all",
        "--octopus",
        ...subset,
      ]);
      return bases.length > 1
        ? lines(dir, ["merge-base", "--independent", ...bases])
        : bases;
    }),
  );
  return new Set(results.flat());
}
