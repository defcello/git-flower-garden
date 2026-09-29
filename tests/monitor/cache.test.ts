import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePrivateCacheRoot } from "../../src/monitor/cache.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

describe.skipIf(process.platform === "win32")("ensurePrivateCacheRoot", () => {
  it("creates the repositories folder readable by the user alone", async () => {
    const root = join(await tempDir(), "cache");
    await ensurePrivateCacheRoot(root);
    expect((await stat(join(root, "repositories"))).mode & 0o777).toBe(0o700);
  });

  it("tightens a folder an earlier version created with default permissions", async () => {
    const root = await tempDir();
    await mkdir(join(root, "repositories"), { mode: 0o755 });
    await ensurePrivateCacheRoot(root);
    expect((await stat(join(root, "repositories"))).mode & 0o777).toBe(0o700);
  });
});
