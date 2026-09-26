import { access } from "node:fs/promises";
import { readGit, records } from "./read.ts";

export interface RepositoryLocation {
  /** Absolute Git directory for the given path (per-worktree for linked worktrees). */
  gitDir: string;
  /** Absolute common Git directory shared by every worktree: the repository's identity. */
  commonDir: string;
  /** Absolute top-level working directory, or null for a bare repository. */
  workTree: string | null;
  bare: boolean;
  objectFormat: string;
  /** True when history is truncated by a shallow clone. */
  shallow: boolean;
  /** True when legacy `info/grafts` may alter parentage; graphs must be flagged. */
  grafts: boolean;
}

/**
 * Resolve a local path to its repository through Git itself, so `.git` files,
 * linked worktrees, and bare repositories are handled without guessing.
 */
export async function resolveRepository(
  path: string,
): Promise<RepositoryLocation> {
  const out = await readGit(
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--is-bare-repository",
      "--is-shallow-repository",
      "--show-object-format",
      "--git-path",
      "info/grafts",
    ],
    { cwd: path },
  );
  const [gitDir, commonDir, bare, shallow, objectFormat, graftsPath] = records(
    out,
    "\n",
  );
  if (
    gitDir === undefined ||
    commonDir === undefined ||
    objectFormat === undefined ||
    graftsPath === undefined
  ) {
    throw new Error(`Unexpected rev-parse output for ${path}`);
  }
  const isBare = bare === "true";
  const workTree = isBare
    ? null
    : (records(
        await readGit(["rev-parse", "--show-toplevel"], { cwd: path }),
        "\n",
      )[0] ?? null);
  return {
    gitDir,
    commonDir,
    workTree,
    bare: isBare,
    objectFormat,
    shallow: shallow === "true",
    grafts: await exists(graftsPath),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
