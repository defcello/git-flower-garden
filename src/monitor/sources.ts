/**
 * Check configured local sources against Git (roadmap sections 4.1 and 6):
 * each path must be a repository, paths that share one common Git directory
 * are the same repository and are rejected as duplicates, and requested
 * remotes must exist.
 */
import { stat } from "node:fs/promises";
import type { Config } from "../config/config.ts";
import { readGit, records } from "../git/read.ts";
import { resolveRepository } from "../git/repository.ts";
import { redactCredentials } from "../git/run-git.ts";

export interface SourceCheck {
  id: string;
  ok: boolean;
  /** Identity of a local repository: its common Git directory. */
  commonDir?: string;
  problems: string[];
}

export async function inspectSources(config: Config): Promise<SourceCheck[]> {
  const byCommonDir = new Map<string, string>();
  const results: SourceCheck[] = [];
  for (const repo of config.repositories) {
    const check: SourceCheck = { id: repo.id, ok: true, problems: [] };
    results.push(check);
    if (repo.path === undefined) continue; // remote URLs are checked when fetched
    const info = await stat(repo.path).catch(() => null);
    if (!info?.isDirectory()) {
      check.problems.push(`path not found: ${repo.path}`);
      continue;
    }
    try {
      const location = await resolveRepository(repo.path);
      // Compare case-insensitively on case-insensitive platforms.
      const key =
        process.platform === "linux"
          ? location.commonDir
          : location.commonDir.toLowerCase();
      check.commonDir = location.commonDir;
      const other = byCommonDir.get(key);
      if (other !== undefined) {
        check.problems.push(
          `same repository as "${other}" (shared Git directory ${location.commonDir}); list it once`,
        );
      } else {
        byCommonDir.set(key, repo.id);
      }
      if (repo.remotes.length > 0) {
        const cwd = location.workTree ?? location.gitDir;
        const known = records(await readGit(["remote"], { cwd }), "\n");
        for (const remote of repo.remotes) {
          if (!known.includes(remote))
            check.problems.push(
              `remote "${remote}" is not configured in this repository`,
            );
        }
      }
    } catch (error) {
      const message = redactCredentials(
        error instanceof Error ? error.message : String(error),
      );
      check.problems.push(
        /not a git repository/i.test(message)
          ? `not a Git repository: ${repo.path}`
          : message,
      );
    }
  }
  for (const r of results) r.ok = r.problems.length === 0;
  return results;
}
