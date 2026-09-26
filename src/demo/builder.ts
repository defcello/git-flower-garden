import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../git/run-git.ts";

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
  /** Annotated tag name -> target commit, tag message, and tagger time (ISO 8601). */
  annotatedTags?: Readonly<
    Record<string, { target: string; message: string; tagged: string }>
  >;
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
export const FIXTURE_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  // Git for Windows maps "/dev/null" to its null device; Node's os.devNull
  // (`\\.\nul`) is rejected by Git for Windows.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fern Example",
  GIT_AUTHOR_EMAIL: "fern@example.invalid",
  GIT_COMMITTER_NAME: "Fern Example",
  GIT_COMMITTER_EMAIL: "fern@example.invalid",
} as const;

/** Run Git in a fixture with the same isolated configuration and identity. */
export function fixtureGit(
  dir: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return runGit(args, {
    cwd: dir,
    env: FIXTURE_ENV,
    ...(input === undefined ? {} : { input }),
  });
}

/** Every commit is created on this ref, which is deleted once real refs exist. */
const SCRATCH_REF = "refs/git-garden-fixture/build";

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
  const git = (args: readonly string[], input?: string) =>
    runGit(args, {
      cwd: dir,
      env: FIXTURE_ENV,
      ...(input === undefined ? {} : { input }),
    });

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

  // A single fast-import process writes every object and ref, which keeps
  // large generated fixtures fast even where process creation is slow.
  const marksFile = join(dir, ".git", "git-garden-fixture-marks");
  await git(
    ["fast-import", "--quiet", "--done", `--export-marks=${marksFile}`],
    fastImportStream(spec),
  );
  const marks = await readFile(marksFile, "utf8");
  await rm(marksFile);
  await git(["update-ref", "-d", SCRATCH_REF]);

  const oids = new Map<string, string>();
  for (const line of marks.split("\n")) {
    const match = /^:(\d+) ([0-9a-f]+)$/.exec(line);
    const commit = match?.[1] && spec.commits[Number(match[1]) - 1];
    if (commit && match[2]) oids.set(commit.name, match[2]);
  }
  if (oids.size !== spec.commits.length) {
    throw new Error(
      `fast-import reported ${String(oids.size)} of ${String(spec.commits.length)} commits`,
    );
  }

  if (head in spec.branches) {
    // Populate the index and working tree so the clone looks freshly checked out.
    await git(["read-tree", "--reset", "-u", "HEAD"]);
  }

  return { dir, oids, oid: (name) => oidOf(oids, name) };
}

function data(text: string): string {
  return `data ${String(Buffer.byteLength(text, "utf8"))}\n${text}\n`;
}

/**
 * Serialize a validated spec as a `git fast-import` stream. Commit i has mark
 * :i+1. Each commit gets a distinct one-file tree so its content identifies it.
 */
function fastImportStream(spec: FixtureSpec): string {
  const marks = new Map(
    spec.commits.map((commit, i) => [commit.name, `:${String(i + 1)}`]),
  );
  const mark = (name: string): string => oidOf(marks, name);
  const identity = `${FIXTURE_ENV.GIT_AUTHOR_NAME} <${FIXTURE_ENV.GIT_AUTHOR_EMAIL}>`;
  const out: string[] = [];

  spec.commits.forEach((commit, i) => {
    const [first, ...rest] = commit.parents ?? [];
    out.push(
      // Reset first so a root commit does not inherit the scratch ref's tip.
      `reset ${SCRATCH_REF}\n`,
      `commit ${SCRATCH_REF}\n`,
      `mark :${String(i + 1)}\n`,
      `author ${identity} ${toGitDate(commit.authored ?? commit.committed)}\n`,
      `committer ${identity} ${toGitDate(commit.committed)}\n`,
      data(`${commit.message ?? commit.name}\n`),
      first === undefined ? "" : `from ${mark(first)}\n`,
      ...rest.map((parent) => `merge ${mark(parent)}\n`),
      "deleteall\n",
      "M 100644 inline plant.txt\n",
      data(`${commit.name}\n`),
      "\n",
    );
  });

  const refs: [ref: string, target: string][] = [
    ...Object.entries(spec.branches).map(([name, target]): [string, string] => [
      `refs/heads/${name}`,
      target,
    ]),
    ...Object.entries(spec.tags ?? {}).map(
      ([name, target]): [string, string] => [`refs/tags/${name}`, target],
    ),
  ];
  for (const [ref, target] of refs) {
    out.push(`reset ${ref}\nfrom ${mark(target)}\n\n`);
  }
  for (const [name, tag] of Object.entries(spec.annotatedTags ?? {})) {
    out.push(
      `tag ${name}\n`,
      `from ${mark(tag.target)}\n`,
      `tagger ${identity} ${toGitDate(tag.tagged)}\n`,
      data(`${tag.message}\n`),
    );
  }
  out.push("done\n");
  return out.join("");
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
    ...Object.entries(spec.annotatedTags ?? {}).map(
      ([name, tag]): [string, string] => [name, tag.target],
    ),
  ];
  for (const [ref, target] of refs) {
    if (!seen.has(target))
      throw new Error(`Ref ${ref} targets unknown commit ${target}`);
  }
}
