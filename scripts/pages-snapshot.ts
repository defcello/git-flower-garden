/*
 * Snapshot well-known public repositories for the static GitHub Pages demo.
 * Each repository is cloned without trees or file contents (commits, branches,
 * and tags are all the garden reads), served once by the real app, and the
 * API responses the UI reads are saved as JSON:
 *
 *   <out>/snapshot.json                 when the snapshot was taken
 *   <out>/repositories.json             GET /api/repositories
 *   <out>/graphs/<id>.json              GET /api/repositories/<id>/graph
 *
 *   npm run pages:snapshot -- <out dir> [work dir]
 *
 * The work directory keeps the clones, so a second run only fetches.
 *
 * Each clone is trimmed to a readable plant before it is read: the default
 * branch, the few most recently active other branches, and the newest tags.
 * Busy projects have hundreds of branches or tags, and the garden draws every
 * head and tag; a plant that size does not fit its place on the hill yet.
 * For the same reason only the newest recent commits are shown.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GraphJson, RepositoriesJson } from "../src/api/types.ts";
import { parseConfig } from "../src/config/config.ts";
import { startApp } from "../src/server/app.ts";

/** Mid-size, active, public repositories with varied shapes. */
const REPOSITORIES = [
  {
    id: "git-flower-garden",
    label: "git-flower-garden",
    repo: "defcello/git-flower-garden",
  },
  { id: "git", label: "Git", repo: "git/git" },
  { id: "react", label: "React", repo: "facebook/react" },
  { id: "vite", label: "Vite", repo: "vitejs/vite" },
  { id: "typescript", label: "TypeScript", repo: "microsoft/TypeScript" },
  { id: "curl", label: "curl", repo: "curl/curl" },
  { id: "neovim", label: "Neovim", repo: "neovim/neovim" },
  { id: "rustlings", label: "Rustlings", repo: "rust-lang/rustlings" },
];

/** The sky follows the real Sun and Moon over Asheville, in the Blue Ridge. */
const ENVIRONMENT = {
  enabled: true,
  latitude: 35.5951,
  longitude: -82.5515,
  elevationMeters: 650,
};
const TIME_ZONE = "America/New_York";

/** Branches kept besides the default branch, newest first. */
const MAX_OTHER_BRANCHES = 5;
/** Branches with no commit for this long are dropped. */
const BRANCH_MAX_AGE_DAYS = 90;
const MAX_TAGS = 3;
/** Busy projects commit dozens of times a day; show only the newest. */
const MAX_RECENT_COMMITS = 12;

const [outArg, workArg] = process.argv.slice(2);
if (!outArg) {
  console.error("Usage: pages-snapshot <out dir> [work dir]");
  process.exit(2);
}
const out = resolve(outArg);
const work = workArg
  ? resolve(workArg)
  : await mkdtemp(join(tmpdir(), "git-flower-garden-pages-"));

function git(args: string[], cwd?: string): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} exited with ${String(result.status)}`,
    );
}

function gitLines(args: string[], cwd: string): string[] {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/** Delete all but the kept refs from a demo clone (never a user's repository). */
function trim(dir: string): { branches: number; tags: number } {
  const defaultBranch = gitLines(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    dir,
  )[0];
  const oldest = Date.now() / 1000 - BRANCH_MAX_AGE_DAYS * 86_400;
  const branches = gitLines(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(committerdate:unix) %(refname)",
      "refs/remotes/origin/",
    ],
    dir,
  ).map((line) => {
    const space = line.indexOf(" ");
    return { time: Number(line.slice(0, space)), ref: line.slice(space + 1) };
  });
  const keep = new Set([
    "refs/remotes/origin/HEAD",
    `refs/remotes/${defaultBranch ?? ""}`,
    ...branches
      .filter(
        ({ ref, time }) =>
          time >= oldest && ref !== `refs/remotes/${defaultBranch ?? ""}`,
      )
      .slice(0, MAX_OTHER_BRANCHES)
      .map(({ ref }) => ref),
    ...gitLines(
      [
        "for-each-ref",
        "--sort=-creatordate",
        `--count=${String(MAX_TAGS)}`,
        "--format=%(refname)",
        "refs/tags/",
      ],
      dir,
    ),
  ]);
  const drop = gitLines(
    ["for-each-ref", "--format=%(refname)", "refs/remotes/", "refs/tags/"],
    dir,
  ).filter((ref) => !keep.has(ref));
  const result = spawnSync("git", ["update-ref", "--stdin"], {
    cwd: dir,
    input: drop.map((ref) => `delete ${ref}\n`).join(""),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`update-ref: ${result.stderr}`);
  const kept = [...keep].filter((ref) => ref !== "refs/remotes/origin/HEAD");
  return {
    branches: kept.filter((ref) => ref.startsWith("refs/remotes/")).length,
    tags: kept.filter((ref) => ref.startsWith("refs/tags/")).length,
  };
}

await mkdir(work, { recursive: true });
for (const { id, repo } of REPOSITORIES) {
  const dir = join(work, id);
  const url = `https://github.com/${repo}.git`;
  const started = performance.now();
  if (existsSync(join(dir, ".git"))) {
    git(["fetch", "--quiet", "--prune", "--tags", "origin"], dir);
  } else {
    // Treeless: no trees or blobs, so even large histories clone quickly.
    git(["clone", "--quiet", "--filter=tree:0", "--no-checkout", url, dir]);
  }
  const kept = trim(dir);
  console.log(
    `${repo}: ${String(Math.round(performance.now() - started))} ms; kept ${String(kept.branches)} branches, ${String(kept.tags)} tags`,
  );
}

const takenAt = Date.now();
const parsed = parseConfig(
  JSON.stringify({
    version: 1,
    history: { timeZone: TIME_ZONE, maxRecentCommits: MAX_RECENT_COMMITS },
    repositories: REPOSITORIES.map(({ id, label }) => ({
      id,
      label,
      path: id,
    })),
    environment: ENVIRONMENT,
  }),
  work,
);
if (!parsed.ok)
  throw new Error(`Invalid configuration: ${JSON.stringify(parsed.errors)}`);

const taken = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: TIME_ZONE,
}).format(takenAt);
const app = await startApp(parsed.config, {
  now: () => takenAt,
  port: 0,
  uiDir: null,
  cacheRoot: join(work, ".cache"),
  notice: `Demo: a snapshot of public repositories taken ${taken} New York time, not live. Install git-flower-garden to watch your own repositories as they change.`,
});
try {
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(new URL(path, app.url));
    if (!response.ok)
      throw new Error(`${path}: HTTP ${String(response.status)}`);
    return (await response.json()) as T;
  };
  const repositories = await get<RepositoriesJson>("/api/repositories");
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "graphs"), { recursive: true });
  for (const repo of repositories.repositories) {
    if (repo.status.state !== "ready")
      throw new Error(
        `${repo.id}: ${repo.status.state} (${repo.status.diagnostic ?? "no diagnostic"})`,
      );
    const graph = await get<GraphJson>(
      `/api/repositories/${encodeURIComponent(repo.id)}/graph`,
    );
    await writeFile(
      join(out, "graphs", `${repo.id}.json`),
      JSON.stringify(graph),
    );
    console.log(
      `${repo.id}: ${String(graph.nodes.length)} of ${String(graph.reachableCount)} commits shown`,
    );
  }
  await writeFile(join(out, "repositories.json"), JSON.stringify(repositories));
  await writeFile(join(out, "snapshot.json"), JSON.stringify({ takenAt }));
} finally {
  await app.close();
  if (!workArg) await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
