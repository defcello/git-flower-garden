import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Content hash, size, and modification time of every file under `root`,
 * including everything inside `.git`. Two equal snapshots mean nothing in the
 * tree was created, deleted, rewritten, or touched.
 */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        result.set(`${key}/`, "dir");
        await walk(path);
      } else {
        const [content, info] = await Promise.all([readFile(path), stat(path)]);
        const hash = createHash("sha256").update(content).digest("hex");
        result.set(key, `${hash} ${String(info.size)} ${String(info.mtimeMs)}`);
      }
    }
  };
  await walk(root);
  return result;
}
