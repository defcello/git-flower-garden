import { readFile } from "node:fs/promises";
import { readGit, readGitRaw, records } from "./read.ts";

export interface TopologyEntry {
  /** Ordered parent OIDs as recorded in the commit (empty at a shallow boundary). */
  parents: string[];
  /** Committer time, seconds since the epoch. */
  committerTime: number;
}

export interface Topology {
  commits: Map<string, TopologyEntry>;
  /** Commits whose parents were cut off by a shallow clone. */
  shallowBoundary: Set<string>;
}

export interface Signature {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** Offset as recorded, e.g. `-0400`. */
  timezone: string;
}

export interface CommitDetails {
  oid: string;
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  /** First line of the message. */
  subject: string;
  /** Full message, decoded as UTF-8 (invalid sequences become U+FFFD). */
  message: string;
}

/**
 * Read the parent topology and committer times of every commit reachable from
 * `tips`. Tips go on standard input so thousands of refs never exceed a
 * command-line length limit.
 */
export async function readTopology(
  cwd: string,
  tips: readonly string[],
  options: {
    maxOutputBytes?: number;
    shallowFile?: string;
    alternates?: readonly string[];
  } = {},
): Promise<Topology> {
  const commits = new Map<string, TopologyEntry>();
  const shallowBoundary = new Set<string>();
  if (tips.length > 0) {
    const output = await readGit(
      ["rev-list", "--parents", "--timestamp", "--stdin"],
      {
        cwd,
        input: tips.map((tip) => `${tip}\n`).join(""),
        maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024 * 1024,
        timeoutMs: 120_000,
        ...(options.alternates ? { alternates: options.alternates } : {}),
      },
    );
    for (const line of records(output, "\n")) {
      const [time, oid, ...parents] = line.split(" ");
      if (!time || !oid) throw new Error(`Unexpected rev-list line: ${line}`);
      commits.set(oid, { parents, committerTime: Number(time) });
    }
  }
  if (options.shallowFile !== undefined) {
    for (const oid of await readShallowFile(options.shallowFile)) {
      if (commits.has(oid)) shallowBoundary.add(oid);
    }
  }
  return { commits, shallowBoundary };
}

async function readShallowFile(path: string): Promise<string[]> {
  try {
    return records(await readFile(path, "utf8"), "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Read full commit objects with `git cat-file --batch`. Output is framed by
 * byte length, so it is parsed as bytes: messages may contain any text,
 * including lines that look like headers or delimiters.
 */
export async function readCommitDetails(
  cwd: string,
  oids: readonly string[],
  options: { alternates?: readonly string[] } = {},
): Promise<Map<string, CommitDetails>> {
  const result = new Map<string, CommitDetails>();
  if (oids.length === 0) return result;
  const out = await readGitRaw(["cat-file", "--batch"], {
    cwd,
    input: oids.map((oid) => `${oid}\n`).join(""),
    maxOutputBytes: 256 * 1024 * 1024,
    ...(options.alternates ? { alternates: options.alternates } : {}),
  });

  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error("Truncated cat-file header");
    const header = out.toString("utf8", offset, headerEnd);
    const [oid, type, size] = header.split(" ");
    if (!oid || type === "missing" || type === undefined) {
      throw new Error(`Commit object not available: ${header}`);
    }
    const start = headerEnd + 1;
    const end = start + Number(size);
    if (type !== "commit" || end > out.length) {
      throw new Error(`Expected a commit object: ${header}`);
    }
    result.set(oid, parseCommit(oid, out.subarray(start, end)));
    offset = end + 1; // content is followed by a newline
  }
  return result;
}

export function parseCommit(oid: string, body: Buffer): CommitDetails {
  const split = body.indexOf("\n\n");
  const headerText = body.toString(
    "utf8",
    0,
    split === -1 ? body.length : split,
  );
  const message =
    split === -1 ? "" : body.toString("utf8", split + 2, body.length);

  let tree = "";
  const parents: string[] = [];
  let author: Signature | undefined;
  let committer: Signature | undefined;
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of gpgsig, mergetag, …
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parseSignature(value);
    else if (key === "committer") committer = parseSignature(value);
  }
  if (!tree || !author || !committer) {
    throw new Error(`Malformed commit object ${oid}`);
  }
  return {
    oid,
    tree,
    parents,
    author,
    committer,
    subject: message.split("\n", 1)[0] ?? "",
    message,
  };
}

function parseSignature(value: string): Signature {
  const match = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!match) throw new Error(`Malformed signature: ${value}`);
  return {
    name: match[1] ?? "",
    email: match[2] ?? "",
    time: Number(match[3]),
    timezone: match[4] ?? "",
  };
}
