import { describe, expect, it } from "vitest";
import { runGit } from "../../src/git/run-git.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";
import {
  buildFixture,
  toGitDate,
  type BuiltFixture,
  type FixtureSpec,
} from "./builder.ts";
import { crissCross, forkMerge, oldBranchHead, threeHeads } from "./demo.ts";

const tempDir = useTempDirs();

async function build(spec: FixtureSpec): Promise<BuiltFixture> {
  return buildFixture(spec, await tempDir());
}

async function gitLines(
  fixture: BuiltFixture,
  args: readonly string[],
): Promise<string[]> {
  const out = await runGit(args, { cwd: fixture.dir });
  return out.split("\n").filter((line) => line.length > 0);
}

describe("toGitDate", () => {
  it("keeps the explicit offset and converts to epoch seconds", () => {
    expect(toGitDate("2026-09-21T09:00:00-04:00")).toBe("1789995600 -0400");
    expect(toGitDate("2026-09-21T13:00:00Z")).toBe("1789995600 +0000");
  });

  it("rejects times without an offset", () => {
    expect(() => toGitDate("2026-09-21T09:00:00")).toThrow(/explicit offset/);
  });
});

describe("buildFixture", () => {
  it("produces identical object IDs on every build and machine", async () => {
    const [first, second] = await Promise.all([
      build(forkMerge),
      build(forkMerge),
    ]);
    expect([...first.oids]).toEqual([...second.oids]);
    // Golden value: guards against hidden dependence on local Git config, OS, or line endings.
    expect(first.oid("merge")).toBe("76aed088c02e114398e6ffb01b68cc10c89b443a");
  });

  it("records ordered parents, refs, and timestamps exactly", async () => {
    const fixture = await build(forkMerge);
    const [mergeLine] = await gitLines(fixture, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "main",
    ]);
    expect(mergeLine).toBe(
      [fixture.oid("merge"), fixture.oid("trunk2"), fixture.oid("feat2")].join(
        " ",
      ),
    );

    const refs = await gitLines(fixture, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    expect(refs.sort()).toEqual(
      [
        `refs/heads/main ${fixture.oid("merge")}`,
        `refs/heads/trellis ${fixture.oid("feat2")}`,
        `refs/tags/v0.1.0 ${fixture.oid("trunk1")}`,
      ].sort(),
    );

    const [times] = await gitLines(fixture, [
      "log",
      "-1",
      "--format=%ct %cI",
      "main",
    ]);
    expect(times).toBe("1789995600 2026-09-21T09:00:00-04:00");
    const message = await runGit(["log", "-1", "--format=%B", "main"], {
      cwd: fixture.dir,
    });
    expect(message.trim()).toBe(
      "Merge branch 'trellis'\n\nThe climbing roses have somewhere to go.",
    );
  });

  it("leaves a clean, checked-out working tree", async () => {
    const fixture = await build(forkMerge);
    expect(await gitLines(fixture, ["status", "--porcelain"])).toEqual([]);
    expect(await gitLines(fixture, ["symbolic-ref", "HEAD"])).toEqual([
      "refs/heads/main",
    ]);
  });

  it("rejects parents that are not defined earlier", async () => {
    const spec: FixtureSpec = {
      description: "invalid",
      commits: [
        {
          name: "child",
          parents: ["later"],
          committed: "2026-09-21T09:00:00-04:00",
        },
      ],
      branches: {},
    };
    await expect(build(spec)).rejects.toThrow(/before it is defined/);
  });
});

describe("demo fixtures exhibit their documented topology", () => {
  it("oldBranchHead: the old head's merge base with main is an old commit", async () => {
    const fixture = await build(oldBranchHead);
    expect(
      await gitLines(fixture, [
        "merge-base",
        "--all",
        "main",
        "archive/prototype",
      ]),
    ).toEqual([fixture.oid("ancient2")]);
  });

  it("threeHeads: best common ancestors differ by head subset", async () => {
    const fixture = await build(threeHeads);
    const base = (...heads: string[]) =>
      gitLines(fixture, ["merge-base", "--all", "--octopus", ...heads]);
    expect(await base("main", "right")).toEqual([fixture.oid("fork")]);
    expect(await base("main", "early")).toEqual([fixture.oid("sprout")]);
    expect(await base("right", "early")).toEqual([fixture.oid("sprout")]);
    expect(await base("main", "right", "early")).toEqual([
      fixture.oid("sprout"),
    ]);
  });

  it("crissCross: two heads have two equally good merge bases", async () => {
    const fixture = await build(crissCross);
    const bases = await gitLines(fixture, [
      "merge-base",
      "--all",
      "main",
      "side",
    ]);
    expect(bases.sort()).toEqual(
      [fixture.oid("left1"), fixture.oid("right1")].sort(),
    );
  });
});
