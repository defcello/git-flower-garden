import { runGit } from "./run-git.ts";

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** The full `git --version` line, including vendor suffixes. */
  raw: string;
}

/**
 * Oldest Git release providing every capability git-flower-garden relies on:
 * `GIT_CONFIG_GLOBAL` (2.32) and `git worktree list --porcelain -z` (2.36).
 * See docs/decisions/0006-toolchain-baseline.md.
 */
export const MINIMUM_GIT_VERSION = { major: 2, minor: 36, patch: 0 } as const;

/** Parse output such as `git version 2.55.0.windows.3` or `git version 2.39.5 (Apple Git-154)`. */
export function parseGitVersion(output: string): GitVersion {
  const raw = output.trim();
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) {
    throw new Error(`Unrecognized Git version output: ${JSON.stringify(raw)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw,
  };
}

export function isSupportedGitVersion(version: GitVersion): boolean {
  const min = MINIMUM_GIT_VERSION;
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

export async function detectGitVersion(cwd: string): Promise<GitVersion> {
  return parseGitVersion(await runGit(["--version"], { cwd }));
}
