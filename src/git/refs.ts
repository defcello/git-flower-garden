import { readGit, records } from "./read.ts";

export type RefKind = "branch" | "remote-branch" | "tag";

export interface GitRef {
  /** Full ref name, e.g. `refs/remotes/origin/main`. */
  name: string;
  kind: RefKind;
  /** Remote name for remote-tracking branches. */
  remote?: string;
  /** Name without its namespace, e.g. `main`, `feature/x`, `v1.0`. */
  shortName: string;
  /** Object the ref points to directly (an annotated tag object for annotated tags). */
  oid: string;
  /** Git object type of `oid`, or "missing" when the object is unavailable. */
  objectType: string;
  /** Fully peeled target of a tag object, or null for a ref that points at a non-tag. */
  peeledOid: string | null;
  peeledType: string | null;
  /** The commit this ref shows at, or null if it resolves to a tree, blob, or missing object. */
  commitOid: string | null;
}

const NAMESPACES = ["refs/heads/", "refs/remotes/", "refs/tags/"];
// Names and OIDs only. Asking for-each-ref for object types makes the whole
// listing fail when a single ref points at a missing object.
const FORMAT = "%(refname)%00%(objectname)%00%(symref)";

/**
 * A namespace read with fixed classification, e.g. an app-owned cache's
 * `refs/garden/<key>/heads/` read as one remote's branches.
 */
export interface RefNamespace {
  prefix: string;
  kind: RefKind;
  remote?: string;
}

/**
 * Enumerate local branches, remote-tracking branches, and tags. Symbolic refs
 * such as `refs/remotes/origin/HEAD` are aliases, not branches, and are skipped.
 * Stash, notes, replace, and other namespaces are outside the default scope.
 * A ref whose object is unavailable is reported with objectType "missing"
 * rather than failing the whole read.
 *
 * With `namespaces`, only those prefixes are read, classified as given.
 */
export async function readRefs(
  cwd: string,
  options: { namespaces?: readonly RefNamespace[] } = {},
): Promise<GitRef[]> {
  const fixed = options.namespaces;
  const [refOutput, remoteOutput] = await Promise.all([
    readGit(
      [
        "for-each-ref",
        `--format=${FORMAT}`,
        ...(fixed ? fixed.map((n) => n.prefix) : NAMESPACES),
      ],
      { cwd },
    ),
    fixed ? Promise.resolve("") : readGit(["remote"], { cwd }),
  ]);
  // Longest first, so remote `a/b` wins over remote `a` for `refs/remotes/a/b/x`.
  const remotes = records(remoteOutput, "\n").sort(
    (a, b) => b.length - a.length,
  );

  const refs: GitRef[] = [];
  for (const line of records(refOutput, "\n")) {
    const [name, oid, symref] = line.split("\0");
    if (!name || !oid || symref) continue;
    const classified = fixed
      ? classifyFixed(name, fixed)
      : classify(name, remotes);
    if (!classified) continue;
    refs.push({
      name,
      ...classified,
      oid,
      objectType: "missing",
      peeledOid: null,
      peeledType: null,
      commitOid: null,
    });
  }
  if (refs.length === 0) return refs;

  // One batch lookup of every direct target; unavailable objects print "<oid> missing".
  const types = records(
    await readGit(["cat-file", "--batch-check=%(objecttype)"], {
      cwd,
      input: refs.map((ref) => `${ref.oid}\n`).join(""),
    }),
    "\n",
  );
  refs.forEach((ref, i) => {
    const line = types[i] ?? "";
    ref.objectType =
      line === "" || line.endsWith(" missing") ? "missing" : line;
    if (ref.objectType === "commit") ref.commitOid = ref.oid;
  });

  const tags = refs.filter((ref) => ref.objectType === "tag");
  if (tags.length > 0) {
    // `^{}` peels through any chain of tag objects. for-each-ref's `*` fields
    // peel only one level on some supported Git versions.
    const peeled = records(
      await readGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        cwd,
        input: tags.map((ref) => `${ref.oid}^{}\n`).join(""),
      }),
      "\n",
    );
    tags.forEach((ref, i) => {
      const [peeledOid, peeledType] = (peeled[i] ?? "").split(" ");
      if (peeledOid && peeledType && peeledType !== "missing") {
        ref.peeledOid = peeledOid;
        ref.peeledType = peeledType;
        ref.commitOid = peeledType === "commit" ? peeledOid : null;
      }
    });
  }
  return refs;
}

function classifyFixed(
  name: string,
  namespaces: readonly RefNamespace[],
): Pick<GitRef, "kind" | "remote" | "shortName"> | null {
  const ns = namespaces.find((n) => name.startsWith(n.prefix));
  if (!ns) return null;
  return {
    kind: ns.kind,
    shortName: name.slice(ns.prefix.length),
    ...(ns.remote === undefined ? {} : { remote: ns.remote }),
  };
}

function classify(
  name: string,
  remotes: readonly string[],
): Pick<GitRef, "kind" | "remote" | "shortName"> | null {
  if (name.startsWith("refs/heads/")) {
    return { kind: "branch", shortName: name.slice("refs/heads/".length) };
  }
  if (name.startsWith("refs/tags/")) {
    return { kind: "tag", shortName: name.slice("refs/tags/".length) };
  }
  const rest = name.slice("refs/remotes/".length);
  const remote = remotes.find((r) => rest.startsWith(`${r}/`));
  if (remote) {
    return {
      kind: "remote-branch",
      remote,
      shortName: rest.slice(remote.length + 1),
    };
  }
  // Tracking refs left behind by a removed remote: keep them, attributed by
  // their first path segment, rather than silently dropping a branch.
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return {
    kind: "remote-branch",
    remote: rest.slice(0, slash),
    shortName: rest.slice(slash + 1),
  };
}
