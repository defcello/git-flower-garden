import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sweepStaleDemos } from "../../src/demo/run-demo.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

it("removes demo directories whose process is gone, and nothing else", async () => {
  const root = await tempDir();
  // A process that has certainly exited.
  const finished = spawnSync(process.execPath, ["-e", "0"]);
  const deadPid = finished.pid;
  expect(deadPid).toBeGreaterThan(0);

  const stale = join(root, "git-flower-garden-demo-stale");
  const legacy = join(root, "git-garden-demo-stale");
  const live = join(root, "git-flower-garden-demo-live");
  const foreign = join(root, "git-flower-garden-demo-no-owner");
  const other = join(root, "something-else");
  for (const dir of [stale, legacy, live, foreign, other]) await mkdir(dir);
  await writeFile(join(stale, ".owner-pid"), String(deadPid));
  await writeFile(join(legacy, ".owner-pid"), String(deadPid));
  await writeFile(join(live, ".owner-pid"), String(process.pid));
  await writeFile(join(other, ".owner-pid"), String(deadPid));

  expect(await sweepStaleDemos(root)).toBe(2);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  expect(existsSync(other)).toBe(true);
});
