import { mkdtemp, rm } from "node:fs/promises";
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
    const dir = await mkdtemp(join(tmpdir(), "git-garden-test-"));
    created.push(dir);
    return dir;
  };
}
