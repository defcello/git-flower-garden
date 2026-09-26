import { runGit } from "../../src/git/run-git.ts";

/** One commit in a fixture, named so tests can refer to it without knowing its OID. */
export interface FixtureCommit {
  name: string;
  /** Names of earlier commits, in Git parent order. Omit for a root commit. */
  parents?: readonly string[];
  /** Commit message. Defaults to the commit name. */
  message?: string;
  /** Committer time: ISO 8601 with an explicit offset, e.g. `2026-09-21T09:00:00-04:00`. */
  committed: string;
  /** Author time, when it should differ from committer time. */
  authored?: string;
}

export interface FixtureSpec {
  description: string;
  /** Commits in creation order; every parent must appear earlier in the list. */
  commits: readonly FixtureCommit[];
  /** Branch short name -> commit name. */
  branches: Readonly<Record<string, string>>;
  /** Lightweight tag name -> commit name. */
  tags?: Readonly<Record<string, string>>;
  /** Branch checked out in the working tree. Defaults to `main`. */
  head?: string;
}

export interface BuiltFixture {
  dir: string;
  /** Commit name -> full object ID. */
  oids: ReadonlyMap<string, string>;
  oid(name: string): string;
}

export interface BuildOptions {
  objectFormat?: "sha1" | "sha256";
}

/**
 * Isolate fixture construction from the developer's own Git configuration and
 * identity so the same spec produces the same object IDs on every machine.
 */
const FIXTURE_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  // Git for Windows maps "/dev/null" to its null device; Node's os.devNull
  // (`\\.\nul`) is rejected by Git for Windows.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fern Example",
  GIT_AUTHOR_EMAIL: "fern@example.invalid",
  GIT_COMMITTER_NAME: "Fern Example",
  GIT_COMMITTER_EMAIL: "fern@example.invalid",
} as const;

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Convert an ISO 8601 timestamp to Git's internal `<epoch> <+hhmm>` date format. */
export function toGitDate(iso: string): string {
  const match = ISO_WITH_OFFSET.exec(iso);
  if (!match?.[1]) {
    throw new Error(
      `Fixture time must be ISO 8601 with an explicit offset: ${iso}`,
    );
  }
  const offset = match[1] === "Z" ? "+0000" : match[1].replace(":", "");
  const epochSeconds = Math.floor(Date.parse(iso) / 1000);
  return `${String(epochSeconds)} ${offset}`;
}

/** Create a repository in `dir` (which must be empty or absent) matching `spec` exactly. */
export async function buildFixture(
  spec: FixtureSpec,
  dir: string,
  options: BuildOptions = {},
): Promise<BuiltFixture> {
  validateSpec(spec);
  const head = spec.head ?? "main";
  const git = (
    args: readonly string[],
    extra: { input?: string; env?: Record<string, string> } = {},
  ) =>
    runGit(args, {
      cwd: dir,
      env: { ...FIXTURE_ENV, ...extra.env },
      ...(extra.input === undefined ? {} : { input: extra.input }),
    }).then((out) => out.trim());

  await runGit(
    [
      "init",
      "--quiet",
      `--object-format=${options.objectFormat ?? "sha1"}`,
      `--initial-branch=${head}`,
      dir,
    ],
    { cwd: process.cwd(), env: FIXTURE_ENV },
  );

  const oids = new Map<string, string>();
  for (const commit of spec.commits) {
    // Each commit gets a distinct one-file tree so its content identifies it.
    const blob = await git(["hash-object", "-w", "--stdin"], {
      input: `${commit.name}\n`,
    });
    const tree = await git(["mktree"], {
      input: `100644 blob ${blob}\tplant.txt\n`,
    });
    const parentArgs = (commit.parents ?? []).flatMap((parent) => [
      "-p",
      oidOf(oids, parent),
    ]);
    const oid = await git(["commit-tree", tree, ...parentArgs, "-F", "-"], {
      input: `${commit.message ?? commit.name}\n`,
      env: {
        GIT_AUTHOR_DATE: toGitDate(commit.authored ?? commit.committed),
        GIT_COMMITTER_DATE: toGitDate(commit.committed),
      },
    });
    oids.set(commit.name, oid);
  }

  for (const [branch, target] of Object.entries(spec.branches)) {
    await git(["update-ref", `refs/heads/${branch}`, oidOf(oids, target)]);
  }
  for (const [tag, target] of Object.entries(spec.tags ?? {})) {
    await git(["update-ref", `refs/tags/${tag}`, oidOf(oids, target)]);
  }
  if (head in spec.branches) {
    // Populate the index and working tree so the clone looks freshly checked out.
    await git(["read-tree", "--reset", "-u", "HEAD"]);
  }

  return { dir, oids, oid: (name) => oidOf(oids, name) };
}

function oidOf(oids: ReadonlyMap<string, string>, name: string): string {
  const oid = oids.get(name);
  if (oid === undefined) throw new Error(`Unknown fixture commit: ${name}`);
  return oid;
}

function validateSpec(spec: FixtureSpec): void {
  const seen = new Set<string>();
  for (const commit of spec.commits) {
    if (seen.has(commit.name))
      throw new Error(`Duplicate fixture commit: ${commit.name}`);
    for (const parent of commit.parents ?? []) {
      if (!seen.has(parent)) {
        throw new Error(
          `Commit ${commit.name} names parent ${parent} before it is defined`,
        );
      }
    }
    toGitDate(commit.committed);
    if (commit.authored !== undefined) toGitDate(commit.authored);
    seen.add(commit.name);
  }
  const refs = [
    ...Object.entries(spec.branches),
    ...Object.entries(spec.tags ?? {}),
  ];
  for (const [ref, target] of refs) {
    if (!seen.has(target))
      throw new Error(`Ref ${ref} targets unknown commit ${target}`);
  }
}
