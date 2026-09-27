import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** Create temporary directories that are removed after the current test file. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterAll(async () => {
    // Git writes read-only object files; rm's retries cope with slow Windows handles.
    await Promise.all(
      created.map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5 }),
      ),
    );
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-flower-garden-test-"));
    created.push(dir);
    return dir;
  };
}

/**
 * Rename, retrying while Windows reports the directory busy: a Git process
 * the monitor runs at that moment (a fetch from a "remote" being taken
 * offline) briefly holds handles in it.
 */
export async function renameWhenFree(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
