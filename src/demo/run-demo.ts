/**
 * Demo mode (roadmap P1-E): serve fictional repositories without any
 * configuration, credentials, or network. Repositories are built in a
 * temporary directory and removed on exit. The clock is fixed at the moment
 * the demo histories were written for, so recent work is visible.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config/config.ts";
import { startApp, type RunningApp } from "../server/app.ts";
import { buildFixture, fixtureGit } from "./builder.ts";
import {
  crissCross,
  forkMerge,
  artProof,
  oldBranchHead,
  threeHeads,
} from "./fixtures.ts";

/** Tuesday 2026-09-22 15:00 in New York: the demo histories' "now". */
export const DEMO_NOW = Date.parse("2026-09-22T15:00:00-04:00");

const DEMO_PREFIX = "git-garden-demo-";
const OWNER_FILE = ".owner-pid";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove demo directories left behind by a demo that was killed rather than
 * stopped (closing the terminal window skips the Ctrl+C cleanup). Only
 * directories whose recorded owner process is gone are removed.
 */
export async function sweepStaleDemos(root = tmpdir()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(DEMO_PREFIX)) continue;
    const dir = join(root, name);
    try {
      const pid = Number(await readFile(join(dir, OWNER_FILE), "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
    } catch {
      // No owner file: not a demo directory this version created; leave it.
      continue;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    removed++;
  }
  return removed;
}

export interface RunningDemo {
  app: RunningApp;
  directory: string;
  close(): Promise<void>;
}

export async function startDemo(
  options: { port?: number; uiDir?: string | null } = {},
): Promise<RunningDemo> {
  await sweepStaleDemos();
  const directory = await mkdtemp(join(tmpdir(), DEMO_PREFIX));
  try {
    await writeFile(join(directory, OWNER_FILE), String(process.pid));
    const repos = [
      { id: "garden-tour", label: "Garden tour", spec: artProof },
      { id: "fork-merge", label: "Fork and merge", spec: forkMerge },
      { id: "criss-cross", label: "Criss-cross merge", spec: crissCross },
      { id: "three-heads", label: "Three heads", spec: threeHeads },
      { id: "old-branch", label: "Old branch head", spec: oldBranchHead },
    ];
    for (const repo of repos)
      await buildFixture(repo.spec, join(directory, repo.id));
    // A worktree and a second name for one commit, so those markers appear too.
    await fixtureGit(join(directory, "fork-merge"), [
      "branch",
      "release",
      "main",
    ]);
    await fixtureGit(join(directory, "fork-merge"), [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      join(directory, "fork-merge-worktree"),
      "trellis",
    ]);
    const parsed = parseConfig(
      JSON.stringify({
        version: 1,
        history: { timeZone: "America/New_York" },
        repositories: repos.map((r) => ({
          id: r.id,
          label: r.label,
          path: r.id,
        })),
      }),
      directory,
    );
    if (!parsed.ok)
      throw new Error(
        `Demo configuration is invalid: ${JSON.stringify(parsed.errors)}`,
      );
    const app = await startApp(parsed.config, {
      now: () => DEMO_NOW,
      cacheRoot: join(directory, ".cache"),
      notice:
        "Demo mode: fictional repositories, with the clock fixed at Tuesday 22 September 2026, 15:00 New York time.",
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
    });
    return {
      app,
      directory,
      close: async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
}
