/*
 * P1-D exit demonstration (roadmap section 9): a live multi-repository
 * service observes local commits, branch and tag creation and deletion,
 * merges, worktree add/remove, remote pushes, remote branch deletion and
 * force-pushes, offline remotes and recovery, configuration reload, restart
 * from cache, and midnight window expiry: each source recovering on its own,
 * without mutating the user's repository.
 */
import { request } from "node:http";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoriesJson } from "../../src/api/types.ts";
import { parseConfig } from "../../src/config/config.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";
import { buildFixture, fixtureGit, FIXTURE_ENV } from "../fixtures/builder.ts";
import { forkMerge, gardenTour } from "../fixtures/demo.ts";
import { snapshotTree } from "../helpers/snapshot.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";
import { runGit } from "../../src/git/run-git.ts";

const tempDir = useTempDirs();

let root: string;
let server: string; // bare remote
let clone: string; // a user's clone that monitors origin through the cache
let teammate: string; // pushes to the remote
let solo: string; // local-only repository changed directly
let configPath: string;
let app: RunningApp;
let now = Date.parse("2026-09-22T15:00:00-04:00");

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `Timed out waiting for ${what}; clone=${JSON.stringify({ status: app.service.view("clone")?.status, remote: app.service.view("clone")?.remote })}`,
      );
    await new Promise((r) => setTimeout(r, 50));
  }
}

const git = (dir: string, ...args: string[]) =>
  fixtureGit(dir, args).then((s) => s.trim());

/** Labels shown on visible commits, e.g. "main", "origin/main", "tag: v1". */
async function labels(id: string): Promise<string[]> {
  const g = await app.service.graph(id);
  return g
    ? [...g.labels.entries()]
        .filter(([oid]) => g.graph.nodes.has(oid))
        .flatMap(([, l]) => l)
        .sort()
    : [];
}

async function oidOfLabel(
  id: string,
  label: string,
): Promise<string | undefined> {
  const g = await app.service.graph(id);
  return [...(g?.labels ?? [])].find(([, l]) => l.includes(label))?.[0];
}

function config(repositories: unknown[]): string {
  return JSON.stringify({
    version: 1,
    history: { timeZone: "America/New_York" },
    monitor: { localReconcileSeconds: 1, remotePollSeconds: 10 },
    repositories,
  });
}

const baseRepos = () => [
  { id: "clone", path: "clone", remotes: ["origin"] },
  { id: "remote", url: pathToFileURL(server).href },
  { id: "solo", path: "solo" },
];

async function commitAt(dir: string, message: string): Promise<string> {
  now += 60_000;
  const date = `${String(Math.floor(now / 1000))} -0400`;
  await runGit(["commit", "--quiet", "--allow-empty", "-m", message], {
    cwd: dir,
    env: { ...FIXTURE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(dir, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = await tempDir();
  const seed = await buildFixture(forkMerge, join(root, "seed"));
  server = join(root, "server.git");
  clone = join(root, "clone");
  teammate = join(root, "teammate");
  await fixtureGit(root, ["clone", "--quiet", "--bare", seed.dir, server]);
  await fixtureGit(root, ["clone", "--quiet", server, clone]);
  await fixtureGit(root, ["clone", "--quiet", server, teammate]);
  solo = (await buildFixture(gardenTour, join(root, "solo"))).dir;
  configPath = join(root, "git-garden.json");
  await writeFile(configPath, config(baseRepos()));
  const parsed = parseConfig(config(baseRepos()), root);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  app = await startApp(parsed.config, {
    now: () => now,
    port: 0,
    uiDir: null,
    configPath,
    configPollMs: 300,
    cacheRoot: join(root, "cache"),
    intervals: { remotePollMs: 400, debounceMs: 100 },
    random: () => 0.5,
  });
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe("live monitoring", () => {
  it("fetches remotes into the cache and treats them as authoritative", async () => {
    const remote = await waitFor("remote-only source", () =>
      app.service.view("remote")?.status.state === "ready"
        ? app.service.view("remote")
        : undefined,
    );
    expect(remote.remote?.state).toBe("ok");
    // v0.1.0 tags a commit outside the window, so it is not among the visible labels.
    expect(await labels("remote")).toEqual(["origin/main", "origin/trellis"]);
    const cloneView = await waitFor("clone remote fetch", () =>
      app.service.view("clone")?.remote?.state === "ok"
        ? app.service.view("clone")
        : undefined,
    );
    expect(cloneView.status.state).toBe("ready");
  });

  it("sees a local commit without reload", async () => {
    const before = app.service.view("solo")?.revision ?? 0;
    const oid = await commitAt(solo, "Water the new bed");
    await waitFor(
      "solo revision",
      () =>
        (app.service.view("solo")?.revision ?? 0) > before ? true : undefined,
      5000,
    );
    expect(await oidOfLabel("solo", "main")).toBe(oid);
  });

  it("follows branch, tag, merge, and worktree changes", async () => {
    await git(solo, "branch", "compost", "HEAD~1");
    await waitFor("new branch", async () =>
      (await labels("solo")).includes("compost") ? true : undefined,
    );
    await git(solo, "tag", "-a", "-m", "Spring", "spring", "HEAD");
    await waitFor("new tag", async () =>
      (await labels("solo")).some((l) => l === "tag: spring")
        ? true
        : undefined,
    );
    await git(solo, "branch", "-D", "compost");
    await waitFor("deleted branch", async () =>
      !(await labels("solo")).includes("compost") ? true : undefined,
    );
    await git(solo, "tag", "-d", "spring");
    await waitFor("deleted tag", async () =>
      !(await labels("solo")).includes("tag: spring") ? true : undefined,
    );

    await git(solo, "checkout", "--quiet", "herbs");
    await commitAt(solo, "Harvest basil");
    await git(solo, "checkout", "--quiet", "main");
    now += 60_000;
    const date = `${String(Math.floor(now / 1000))} -0400`;
    await runGit(
      // "-s ours": fixture commits all rewrite one file, so a content merge
      // would conflict; this still records a real two-parent merge.
      [
        "merge",
        "--quiet",
        "--no-ff",
        "-s",
        "ours",
        "-m",
        "Merge herbs",
        "herbs",
      ],
      {
        cwd: solo,
        env: {
          ...FIXTURE_ENV,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    );
    const merge = await git(solo, "rev-parse", "HEAD");
    await waitFor("merge", async () =>
      (await oidOfLabel("solo", "main")) === merge ? true : undefined,
    );
    const g = await app.service.graph("solo");
    expect(g?.graph.edges.filter((e) => e.child === merge)).toHaveLength(2);

    const wt = join(root, "solo-wt");
    await git(solo, "worktree", "add", "--quiet", "--detach", wt, "HEAD~1");
    await waitFor("worktree", async () =>
      (await app.service.graph("solo"))?.worktrees.some((w) =>
        w.path.endsWith("solo-wt"),
      )
        ? true
        : undefined,
    );
    await git(solo, "worktree", "remove", "--force", wt);
    await waitFor("worktree removed", async () =>
      (await app.service.graph("solo"))?.worktrees.every(
        (w) => !w.path.endsWith("solo-wt"),
      )
        ? true
        : undefined,
    );
  });

  it("reflects remote pushes, deletions, and force-pushes without touching the user's clone", async () => {
    const cloneBefore = await snapshotTree(clone);
    const pushed = await commitAt(teammate, "Prune the roses");
    await git(teammate, "push", "--quiet", "origin", "HEAD:main");
    await waitFor("remote-only sees push", async () =>
      (await oidOfLabel("remote", "origin/main")) === pushed ? true : undefined,
    );
    await waitFor("clone sees push", async () =>
      (await oidOfLabel("clone", "origin/main")) === pushed ? true : undefined,
    );
    // The clone's own tracking ref still says what it last fetched; the graph shows the remote's current state.
    expect(await git(clone, "rev-parse", "refs/remotes/origin/main")).not.toBe(
      pushed,
    );

    await git(teammate, "push", "--quiet", "origin", "--delete", "trellis");
    await waitFor("remote branch deleted", async () =>
      !(await labels("remote")).includes("origin/trellis") ? true : undefined,
    );

    // Force-push main back to an older commit: the pushed commit disappears.
    await git(teammate, "reset", "--quiet", "--hard", "HEAD~1");
    await git(teammate, "push", "--quiet", "--force", "origin", "HEAD:main");
    await waitFor("force-push", async () => {
      const g = await app.service.graph("remote");
      return g && !g.graph.nodes.has(pushed) ? true : undefined;
    });
    expect(await snapshotTree(clone)).toEqual(cloneBefore);
  });

  it("keeps last known state while a remote is offline, backs off, and recovers", async () => {
    const hidden = `${server}.offline`;
    await rename(server, hidden);
    const offline = await waitFor("remote error and stale state", () => {
      const v = app.service.view("remote");
      return v?.remote?.state === "error" && v.status.state === "stale"
        ? v
        : undefined;
    });
    expect(offline.status.state).toBe("stale");
    expect(offline.snapshot).not.toBeNull();
    expect(
      (await app.service.graph("remote"))?.graph.nodes.size,
    ).toBeGreaterThan(0);
    // The local clone keeps working; only its remote freshness is affected.
    await waitFor("clone remote error", () =>
      app.service.view("clone")?.remote?.state === "error" ? true : undefined,
    );
    expect(app.service.view("clone")?.status).toMatchObject({ state: "ready" });
    const commit = await commitAt(solo, "Still local while offline");
    await waitFor("local still live", async () =>
      (await oidOfLabel("solo", "main")) === commit ? true : undefined,
    );

    await rename(hidden, server);
    await waitFor(
      "remote recovered",
      () => {
        const v = app.service.view("remote");
        return v?.remote?.state === "ok" && v.status.state === "ready"
          ? true
          : undefined;
      },
      20_000,
    );
  }, 40_000);

  it("streams full status over server-sent events and resynchronizes on connect", async () => {
    const events: RepositoriesJson[] = [];
    const req = request(`${app.url}api/events`);
    const done = new Promise<void>((resolve) => {
      req.on("response", (res) => {
        expect(res.headers["content-type"]).toBe(
          "text/event-stream; charset=utf-8",
        );
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end === -1) break;
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data)
              events.push(JSON.parse(data.slice(6)) as RepositoriesJson);
          }
        });
        res.on("close", () => {
          resolve();
        });
      });
    });
    req.end();
    // The first message is the complete current state.
    const first = await waitFor("first event", () => events[0]);
    expect(first.repositories.map((r) => r.id)).toEqual([
      "clone",
      "remote",
      "solo",
    ]);
    const before =
      first.repositories.find((r) => r.id === "solo")?.revision ?? 0;
    await commitAt(solo, "Streamed change");
    await waitFor("streamed revision", () =>
      events.some(
        (e) =>
          (e.repositories.find((r) => r.id === "solo")?.revision ?? 0) > before,
      )
        ? true
        : undefined,
    );
    req.destroy();
    await done;
  });

  it("reloads configuration: invalid edits keep the last valid config; valid ones add and remove sources", async () => {
    await writeFile(configPath, '{ "version": 1, "repositories": [ }');
    await waitFor("config error", () =>
      app.health().configErrors.length > 0 ? true : undefined,
    );
    expect(app.health().configErrors[0]).toMatch(
      /^git-garden\.json:1:\d+: invalid JSON/,
    );
    expect(app.service.ids()).toEqual(["clone", "remote", "solo"]);

    await writeFile(
      configPath,
      config([
        ...baseRepos().filter((r) => r.id !== "solo"),
        { id: "solo-2", label: "Solo again", path: "solo" },
      ]),
    );
    await waitFor("reloaded", () =>
      app.service.ids().includes("solo-2") ? true : undefined,
    );
    expect(app.health().configErrors).toEqual([]);
    expect(app.service.ids()).toEqual(["clone", "remote", "solo-2"]);
    expect(app.service.view("solo")).toBeUndefined();
    await waitFor("new source read", () =>
      app.service.view("solo-2")?.status.state === "ready" ? true : undefined,
    );

    await writeFile(
      configPath,
      JSON.stringify({
        ...JSON.parse(config(baseRepos())),
        server: { host: "localhost" },
      }),
    );
    await waitFor("restart notice", () =>
      app.health().restartNeeded.includes("server.host") ? true : undefined,
    );
  });

  it("moves the window at midnight without any repository change", async () => {
    await waitFor("solo ready", () =>
      app.service.view("solo")?.status.state === "ready" ? true : undefined,
    );
    const before = (await app.service.graph("solo"))?.graph.nodes.size ?? 0;
    let windowEvents = 0;
    const unsubscribe = app.service.subscribe((e) => {
      if (e.type === "window") windowEvents++;
    });
    // Advance to the following Monday morning: last week's commits leave the window.
    now = Date.parse("2026-09-28T08:00:00-04:00");
    await waitFor(
      "window event",
      () => (windowEvents > 0 ? true : undefined),
      5000,
    );
    unsubscribe();
    const after = (await app.service.graph("solo"))?.graph.nodes.size ?? 0;
    expect(after).toBeLessThan(before);
  });
});

describe("restart from cache", () => {
  it("shows last known remote state immediately, marked stale while the remote is unreachable", async () => {
    await app.close();
    await rename(server, `${server}.gone`);
    const parsed = parseConfig(
      config([{ id: "remote", url: pathToFileURL(server).href }]),
      root,
    );
    if (!parsed.ok) throw new Error("config");
    app = await startApp(parsed.config, {
      now: () => now,
      port: 0,
      uiDir: null,
      cacheRoot: join(root, "cache"),
      intervals: { remotePollMs: 400 },
      random: () => 0.5,
    });
    const view = app.service.view("remote");
    expect(view?.snapshot).not.toBeNull();
    expect(view?.remote?.lastSuccess).not.toBeNull();
    await waitFor("offline noted", () =>
      app.service.view("remote")?.status.state === "stale" ? true : undefined,
    );
    expect(app.service.view("remote")?.status.diagnostic).toMatch(
      /remote unreachable/,
    );
  });
});
