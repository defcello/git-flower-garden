/*
 * P0-B Git-output probe and P1-A reader tests. Each reader is checked against
 * ground truth from the fixture spec and against a different Git command than
 * the one the reader uses, and every read is shown to leave the repository
 * byte-for-byte unchanged.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readCommitDetails, readTopology } from "../../src/git/commits.ts";
import { readRefs } from "../../src/git/refs.ts";
import { resolveRepository } from "../../src/git/repository.ts";
import { readWorktrees } from "../../src/git/worktrees.ts";
import {
  buildFixture,
  fixtureGit,
  toGitDate,
  type BuiltFixture,
  type FixtureSpec,
} from "../../src/demo/builder.ts";
import { snapshotTree } from "../helpers/snapshot.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

const TRICKY_MESSAGE = [
  "Graft the heirloom rosé 🌹",
  "",
  "tree 0000000000000000000000000000000000000000",
  "parent looks-like-a-header",
  "",
  "Ünïcode lines and a blank line above change byte counts.",
].join("\n");

const spec: FixtureSpec = {
  description: "Reader probe: merges, octopus, slashed names, tags.",
  commits: [
    {
      name: "root",
      message: "Plant the seed",
      committed: "2026-09-14T09:00:00-04:00",
    },
    {
      name: "a",
      parents: ["root"],
      message: TRICKY_MESSAGE,
      committed: "2026-09-15T09:00:00-04:00",
      authored: "2026-09-10T08:30:00+02:00",
    },
    { name: "b", parents: ["root"], committed: "2026-09-15T10:00:00-04:00" },
    { name: "c", parents: ["root"], committed: "2026-09-15T11:00:00-04:00" },
    {
      name: "merge",
      parents: ["a", "b"],
      committed: "2026-09-16T09:00:00-04:00",
    },
    {
      name: "octopus",
      parents: ["merge", "c", "b"],
      committed: "2026-09-17T09:00:00-04:00",
    },
  ],
  branches: { main: "octopus", "feature/x": "c", older: "a" },
  tags: { light: "b" },
  annotatedTags: {
    "v1.0": {
      target: "merge",
      message: "First bloom",
      tagged: "2026-09-16T12:00:00-04:00",
    },
  },
};

let fixture: BuiltFixture;
let root: string;
const wt = (name: string): string => join(root, name);

beforeAll(async () => {
  root = await tempDir();
  fixture = await buildFixture(spec, join(root, "repo"));
  const git = (...args: string[]) => fixtureGit(fixture.dir, args);
  // Tag objects that are not simple: a tag of a tag, and a tag of a tree.
  await git("tag", "-a", "-m", "Tag of a tag", "nested", "v1.0");
  await git(
    "tag",
    "-a",
    "-m",
    "Tag of a tree",
    "tree-tag",
    `${fixture.oid("root")}^{tree}`,
  );
  // Remotes, including a slash in the remote name and a symbolic origin/HEAD.
  await git("remote", "add", "origin", "https://example.invalid/garden.git");
  await git(
    "remote",
    "add",
    "up/stream",
    "https://example.invalid/upstream.git",
  );
  await git("update-ref", "refs/remotes/origin/main", fixture.oid("merge"));
  await git("update-ref", "refs/remotes/up/stream/main", fixture.oid("c"));
  await git(
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  // Out-of-scope namespaces.
  await git("update-ref", "refs/stash", fixture.oid("b"));
  await git("update-ref", "refs/notes/commits", fixture.oid("b"));
  await git("update-ref", "refs/pull/1/head", fixture.oid("b"));
  // Worktrees: attached, detached, locked, unborn, and prunable (missing).
  await git("worktree", "add", "--quiet", wt("wt-feature"), "feature/x");
  await git(
    "worktree",
    "add",
    "--quiet",
    "--detach",
    wt("wt-detached"),
    fixture.oid("a"),
  );
  await git(
    "worktree",
    "lock",
    "--reason",
    "on a removable drive",
    wt("wt-feature"),
  );
  await git(
    "worktree",
    "add",
    "--quiet",
    "--detach",
    wt("wt-unborn"),
    fixture.oid("root"),
  );
  await fixtureGit(wt("wt-unborn"), [
    "symbolic-ref",
    "HEAD",
    "refs/heads/seedling",
  ]);
  await git(
    "worktree",
    "add",
    "--quiet",
    "--detach",
    wt("wt-gone"),
    fixture.oid("b"),
  );
  await rm(wt("wt-gone"), { recursive: true, force: true });
});

describe("resolveRepository", () => {
  it("identifies linked worktrees by their shared common directory", async () => {
    const main = await resolveRepository(fixture.dir);
    const linked = await resolveRepository(wt("wt-feature"));
    expect(linked.commonDir).toBe(main.commonDir);
    expect(linked.gitDir).not.toBe(main.gitDir);
    expect(linked.workTree?.endsWith("wt-feature")).toBe(true);
    expect(main).toMatchObject({
      bare: false,
      shallow: false,
      grafts: false,
      objectFormat: "sha1",
    });
  });

  it("resolves from a subdirectory and handles bare repositories", async () => {
    const sub = join(fixture.dir, "nested", "deeper");
    await mkdir(sub, { recursive: true });
    expect((await resolveRepository(sub)).workTree).toBe(
      (await resolveRepository(fixture.dir)).workTree,
    );
    await rm(join(fixture.dir, "nested"), { recursive: true });

    const bare = join(root, "bare.git");
    await fixtureGit(root, ["clone", "--quiet", "--bare", fixture.dir, bare]);
    expect(await resolveRepository(bare)).toMatchObject({
      bare: true,
      workTree: null,
    });
  });

  it("flags legacy grafts and shallow clones", async () => {
    const shallow = join(root, "shallow");
    await fixtureGit(root, [
      "clone",
      "--quiet",
      "--depth",
      "2",
      "--no-local",
      `file://${fixture.dir.replaceAll("\\", "/")}`,
      shallow,
    ]);
    const location = await resolveRepository(shallow);
    expect(location.shallow).toBe(true);

    const graftDir = await tempDir();
    const grafted = await buildFixture(spec, graftDir);
    await writeFile(
      join(grafted.dir, ".git", "info", "grafts"),
      `${grafted.oid("a")}\n`,
    );
    expect((await resolveRepository(grafted.dir)).grafts).toBe(true);
  });
});

describe("readRefs", () => {
  it("matches git show-ref --dereference and the fixture spec", async () => {
    const refs = await readRefs(fixture.dir);
    const byName = new Map(refs.map((r) => [r.name, r]));

    // Independent listing: show-ref prints direct targets plus fully peeled `^{}` lines.
    const showRef = (
      await fixtureGit(fixture.dir, ["show-ref", "--dereference"])
    )
      .trim()
      .split("\n");
    const direct = new Map<string, string>();
    const peeled = new Map<string, string>();
    for (const line of showRef) {
      const [oid, name] = line.split(" ") as [string, string];
      if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), oid);
      else direct.set(name, oid);
    }
    const inScope = [...direct.keys()].filter(
      (name) =>
        /^refs\/(heads|tags|remotes)\//.test(name) &&
        name !== "refs/remotes/origin/HEAD",
    );
    expect([...byName.keys()].sort()).toEqual(inScope.sort());
    for (const ref of refs) {
      expect(ref.oid, ref.name).toBe(direct.get(ref.name));
      expect(ref.peeledOid, ref.name).toBe(peeled.get(ref.name) ?? null);
    }

    expect(byName.get("refs/heads/feature/x")).toMatchObject({
      kind: "branch",
      shortName: "feature/x",
      commitOid: fixture.oid("c"),
    });
    expect(byName.get("refs/remotes/up/stream/main")).toMatchObject({
      kind: "remote-branch",
      remote: "up/stream",
      shortName: "main",
    });
    expect(byName.get("refs/remotes/origin/main")).toMatchObject({
      remote: "origin",
      commitOid: fixture.oid("merge"),
    });
    expect(byName.get("refs/tags/light")).toMatchObject({
      objectType: "commit",
      commitOid: fixture.oid("b"),
      peeledOid: null,
    });
    expect(byName.get("refs/tags/v1.0")).toMatchObject({
      objectType: "tag",
      peeledType: "commit",
      commitOid: fixture.oid("merge"),
    });
    expect(byName.get("refs/tags/nested")).toMatchObject({
      objectType: "tag",
      peeledType: "commit",
      commitOid: fixture.oid("merge"),
    });
    expect(byName.get("refs/tags/tree-tag")).toMatchObject({
      objectType: "tag",
      peeledType: "tree",
      commitOid: null,
    });
    expect(byName.has("refs/stash")).toBe(false);
    expect(byName.has("refs/remotes/origin/HEAD")).toBe(false);
  });
});

describe("readWorktrees", () => {
  it("reports attached, detached, locked, unborn, and prunable worktrees", async () => {
    const list = await readWorktrees(fixture.dir);
    const byName = new Map(list.map((w) => [w.path.split("/").at(-1), w]));
    expect(list[0]).toMatchObject({
      main: true,
      branch: "refs/heads/main",
      headOid: fixture.oid("octopus"),
    });
    expect(byName.get("wt-feature")).toMatchObject({
      branch: "refs/heads/feature/x",
      headOid: fixture.oid("c"),
      locked: "on a removable drive",
      detached: false,
    });
    expect(byName.get("wt-detached")).toMatchObject({
      branch: null,
      detached: true,
      headOid: fixture.oid("a"),
      locked: null,
    });
    expect(byName.get("wt-unborn")).toMatchObject({
      branch: "refs/heads/seedling",
      headOid: null,
    });
    expect(byName.get("wt-gone")?.prunable).toMatch(/non-existent/);
    expect(list).toHaveLength(5);

    // Cross-check the HEADs of live worktrees with rev-parse run inside each one.
    for (const name of ["wt-feature", "wt-detached"]) {
      const head = (await fixtureGit(wt(name), ["rev-parse", "HEAD"])).trim();
      expect(byName.get(name)?.headOid).toBe(head);
    }
  });
});

describe("readTopology and readCommitDetails", () => {
  it("reproduce the spec's ordered parents, timestamps, and exact messages", async () => {
    const heads = [fixture.oid("octopus"), fixture.oid("a")];
    const topology = await readTopology(fixture.dir, heads);
    expect(topology.commits.size).toBe(spec.commits.length);
    for (const commit of spec.commits) {
      const entry = topology.commits.get(fixture.oid(commit.name));
      expect(entry?.parents, commit.name).toEqual(
        (commit.parents ?? []).map((p) => fixture.oid(p)),
      );
      expect(String(entry?.committerTime)).toBe(
        toGitDate(commit.committed).split(" ")[0],
      );
    }

    const details = await readCommitDetails(fixture.dir, [
      ...topology.commits.keys(),
    ]);
    for (const commit of spec.commits) {
      const d = details.get(fixture.oid(commit.name));
      // Parents parsed from raw objects must agree with rev-list's view.
      expect(d?.parents).toEqual(
        topology.commits.get(fixture.oid(commit.name))?.parents,
      );
      expect(d?.message).toBe(`${commit.message ?? commit.name}\n`);
      const [authorTime, authorZone] = toGitDate(
        commit.authored ?? commit.committed,
      ).split(" ");
      expect([String(d?.author.time), d?.author.timezone]).toEqual([
        authorTime,
        authorZone,
      ]);
      expect(d?.committer.name).toBe("Fern Example");
    }
    expect(details.get(fixture.oid("a"))?.subject).toBe(
      "Graft the heirloom rosé 🌹",
    );
  });

  it("marks shallow boundaries instead of inventing roots", async () => {
    const shallow = join(await tempDir(), "shallow");
    await fixtureGit(fixture.dir, [
      "clone",
      "--quiet",
      "--depth",
      "2",
      "--no-local",
      "--branch",
      "main",
      `file://${fixture.dir.replaceAll("\\", "/")}`,
      shallow,
    ]);
    const location = await resolveRepository(shallow);
    const tip = (await fixtureGit(shallow, ["rev-parse", "HEAD"])).trim();
    const topology = await readTopology(shallow, [tip], {
      shallowFile: join(location.commonDir, "shallow"),
    });
    // Depth 2 from the octopus keeps it and its three parents; they are the boundary.
    expect([...topology.shallowBoundary].sort()).toEqual(
      [fixture.oid("merge"), fixture.oid("c"), fixture.oid("b")].sort(),
    );
    for (const oid of topology.shallowBoundary)
      expect(topology.commits.get(oid)?.parents).toEqual([]);
  });

  it("returns nothing for no tips and fails loudly for a missing object", async () => {
    expect((await readTopology(fixture.dir, [])).commits.size).toBe(0);
    await expect(
      readCommitDetails(fixture.dir, [
        "0123456789012345678901234567890123456789",
      ]),
    ).rejects.toThrow(/not available/);
  });
});

describe("read-only guarantee", () => {
  it("leaves every file of the repository and its worktrees unchanged", async () => {
    const before = await snapshotTree(root);
    const location = await resolveRepository(fixture.dir);
    const refs = await readRefs(fixture.dir);
    await readWorktrees(fixture.dir);
    const tips = refs.flatMap((r) => (r.commitOid ? [r.commitOid] : []));
    const topology = await readTopology(fixture.dir, tips, {
      shallowFile: join(location.commonDir, "shallow"),
    });
    await readCommitDetails(fixture.dir, [...topology.commits.keys()]);
    await resolveRepository(wt("wt-feature"));
    await readRefs(wt("wt-detached"));
    const after = await snapshotTree(root);
    expect(after).toEqual(before);
  });
});
