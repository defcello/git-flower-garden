/**
 * Filesystem change hints for a local repository (roadmap section 5.2).
 *
 * Only ref metadata is watched: the common Git directory itself (HEAD,
 * packed-refs, reftable), `refs/`, `worktrees/`, and each linked worktree's
 * Git directory. Object writes are not watched; a commit always updates a ref.
 * Events are hints only: periodic reconciliation remains the source of truth,
 * because watchers can miss events or fail on some filesystems.
 */
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface RepositoryWatch {
  close(): void;
  /** Paths actually being watched (a missing directory is skipped). */
  paths: string[];
}

export function watchRepository(
  dirs: { commonDir: string; gitDirs: readonly string[] },
  onChange: () => void,
  onError: (error: Error) => void,
): RepositoryWatch {
  const targets: { path: string; recursive: boolean }[] = [
    { path: dirs.commonDir, recursive: false },
    { path: join(dirs.commonDir, "refs"), recursive: true },
    { path: join(dirs.commonDir, "reftable"), recursive: false },
    { path: join(dirs.commonDir, "worktrees"), recursive: true },
    ...dirs.gitDirs
      .filter((d) => d !== dirs.commonDir)
      .map((path) => ({ path, recursive: false })),
  ];
  const watchers: FSWatcher[] = [];
  const paths: string[] = [];
  for (const target of targets) {
    try {
      const w = watch(
        target.path,
        { recursive: target.recursive, persistent: false },
        () => {
          onChange();
        },
      );
      w.on("error", (error) => {
        onError(error);
      });
      watchers.push(w);
      paths.push(target.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Optional directories (reftable, worktrees) may not exist.
      if (code !== "ENOENT") onError(error as Error);
    }
  }
  return {
    paths,
    close: () => {
      for (const w of watchers) w.close();
    },
  };
}
