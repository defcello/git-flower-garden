import { runGit, runGitRaw, type RunGitOptions } from "./run-git.ts";

/**
 * Environment for every read of a user-owned repository (ADR 0002).
 *
 * - GIT_OPTIONAL_LOCKS=0: never take optional locks or refresh the index as a
 *   side effect.
 * - GIT_NO_LAZY_FETCH=1: in a partial clone, never fetch a missing object from
 *   the promisor remote into the user's repository (Git 2.44+; older Git
 *   ignores it, so readers must avoid touching trees and blobs).
 * - GIT_NO_REPLACE_OBJECTS=1: read physical parentage, not `refs/replace`.
 */
export const READ_ONLY_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
} as const;

export type ReadGitOptions = Omit<RunGitOptions, "env">;

/** Run a read-only Git command against a user-owned repository. */
export function readGit(
  args: readonly string[],
  options: ReadGitOptions,
): Promise<string> {
  return runGit(args, { ...options, env: READ_ONLY_ENV });
}

/** Like {@link readGit}, but resolve with raw bytes for length-framed output. */
export function readGitRaw(
  args: readonly string[],
  options: ReadGitOptions,
): Promise<Buffer> {
  return runGitRaw(args, { ...options, env: READ_ONLY_ENV });
}

/** Split NUL- or newline-terminated output into records, dropping the final empty one. */
export function records(output: string, separator: "\0" | "\n"): string[] {
  const parts = output.split(separator);
  if (parts.at(-1) === "") parts.pop();
  return parts;
}
