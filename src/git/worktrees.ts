import { readGit, records } from "./read.ts";

export interface GitWorktree {
  /** Absolute path as Git records it (forward slashes on Windows). */
  path: string;
  /** Checked-out commit, or null when the worktree's branch is unborn or it is bare. */
  headOid: string | null;
  /** Attached branch (full ref name), or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Lock reason ("" when locked without a reason), or null when unlocked. */
  locked: string | null;
  /** Why Git considers the worktree prunable, or null. Never pruned by git-garden. */
  prunable: string | null;
  /** True for the main worktree (listed first by Git). */
  main: boolean;
}

/** List worktrees with `git worktree list --porcelain -z` (Git 2.36+). */
export async function readWorktrees(cwd: string): Promise<GitWorktree[]> {
  const output = await readGit(["worktree", "list", "--porcelain", "-z"], {
    cwd,
  });
  return parseWorktreeList(output);
}

/**
 * Parse porcelain `-z` output: NUL-terminated attribute lines, with an empty
 * record (a second NUL) ending each worktree.
 */
export function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of records(output, "\0")) {
    if (line === "") {
      current = undefined;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      current = {
        path: value,
        headOid: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
        main: worktrees.length === 0,
      };
      worktrees.push(current);
      continue;
    }
    if (!current) throw new Error(`Worktree attribute before path: ${key}`);
    switch (key) {
      case "HEAD":
        current.headOid = /^0+$/.test(value) ? null : value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = value;
        break;
      case "prunable":
        current.prunable = value;
        break;
      default:
        // Future Git attributes are ignored rather than rejected.
        break;
    }
  }
  return worktrees;
}
