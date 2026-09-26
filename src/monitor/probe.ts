/**
 * A cheap fingerprint of a repository's ref metadata, taken with file-system
 * `stat` calls only (no Git processes). Reconciliation compares fingerprints
 * and skips the full read when nothing changed; a periodic full read still
 * runs regardless, covering filesystems with coarse timestamps and changes
 * the fingerprint cannot see (e.g. a linked worktree deleted elsewhere).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function statLine(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${path}\t${String(s.size)}\t${String(s.mtimeMs)}`;
  } catch {
    return `${path}\t-`;
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    out.push(`${dir}\t-`);
    return;
  }
  out.push(
    `${dir}\t[${entries
      .map((e) => e.name)
      .sort()
      .join(",")}]`,
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else out.push(await statLine(path));
  }
}

export async function refFingerprint(commonDir: string): Promise<string> {
  const lines: string[] = [];
  for (const file of ["HEAD", "packed-refs", "shallow", "config"]) {
    lines.push(await statLine(join(commonDir, file)));
  }
  await walk(join(commonDir, "refs"), lines);
  await walk(join(commonDir, "reftable"), lines);
  // Per-worktree HEADs and metadata; the listing also shows adds and removals.
  await walk(join(commonDir, "worktrees"), lines);
  return lines.join("\n");
}
