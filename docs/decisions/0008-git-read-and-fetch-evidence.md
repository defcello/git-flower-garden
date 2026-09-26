# 0008: Git machine-readable output and fetch isolation — evidence

- Status: Accepted (P0-B evidence)
- Date: 2026-09-26
- Roadmap: sections 4.1, 5.1, 8 (P0-B), 13

## Questions

1. Can the installed Git report refs, annotated tags, worktrees (including
   detached and unborn), ordered parents, and full commit messages in formats we
   can parse without guessing?
2. Can an app-owned cache see remote updates without changing anything in the
   user's clone?

## Readers built

| Module | Git command | Notes |
| --- | --- | --- |
| `src/git/read.ts` | (environment) | Every user-repository read sets `GIT_OPTIONAL_LOCKS=0` (no index refresh), `GIT_NO_LAZY_FETCH=1` (no promisor fetch into a partial clone; Git 2.44+), and `GIT_NO_REPLACE_OBJECTS=1` (physical parentage). |
| `src/git/repository.ts` | `rev-parse --path-format=absolute --git-dir --git-common-dir …` | Identity is the common Git directory, so linked worktrees resolve to one repository. It also reports bare, shallow, object format, and whether legacy `info/grafts` exists. |
| `src/git/refs.ts` | `for-each-ref` with NUL-separated fields, then `cat-file --batch-check` on `<oid>^{}` | Symbolic refs (`origin/HEAD`) are skipped. Remote names containing `/` resolve by longest match against `git remote`. |
| `src/git/worktrees.ts` | `worktree list --porcelain -z` | An unborn branch reports `HEAD 0000…`, which becomes `headOid: null`. Locked (with reason), prunable, detached, and bare are all reported. |
| `src/git/commits.ts` | `rev-list --parents --timestamp --stdin`; `cat-file --batch` | Tips go on standard input, avoiding Windows command-line limits. Commit bodies are parsed as length-framed bytes, so messages containing `tree …` or `parent …` lines, blank lines, or multi-byte UTF-8 parse exactly. Shallow boundaries come from the `shallow` file. |

## Findings

- **Tag peeling:** in Git 2.55, `for-each-ref`'s `%(*objectname)` fully peeled a
  tag of a tag. That is not guaranteed across our supported range (2.36+), so
  peeling uses `cat-file` with `^{}`, which always peels completely. A tag of a
  tree peels to a tree and gets no commit node (`commitOid: null`).
- **Partial clones:** without `GIT_NO_LAZY_FETCH`, reading a missing object can
  fetch it from the promisor remote *into the user's repository*. The readers
  only read commits and refs, which partial clones always hold. Git older than
  2.44 ignores the variable, so readers must keep away from trees and blobs.
- **Shallow clones:** `rev-list` reports boundary commits with no parents.
  Readers mark these from the `shallow` file rather than treating them as roots.
- **Removed remotes:** tracking refs left behind by a removed remote are kept and
  attributed by their first path segment rather than silently dropped.

## Fetch isolation

`src/git/remote-cache.ts` fetches into an app-owned bare repository with explicit
refspecs `+refs/heads/*:refs/garden/<key>/heads/*` and
`+refs/tags/*:refs/garden/<key>/tags/*`. It also uses `--prune`, `--no-tags`,
`--no-write-fetch-head`, `--no-recurse-submodules`, and `--end-of-options`, with
`GIT_ALLOW_PROTOCOL=https:http:ssh:git:file` and automatic gc and maintenance
off. The URL comes from `git ls-remote --get-url` in the user's clone, which
applies `insteadOf` rewriting without network access.

`tests/git/remote-cache.test.ts` demonstrates:

- After a teammate pushes a new commit, creates a branch, deletes a branch,
  force-moves a tag, and adds an annotated tag, the cache's refs equal
  `git ls-remote` of the server exactly, and the new commit object is present.
- The user's clone is **byte-for-byte identical** before and after: every file
  under the clone, including `.git`, compared by content hash, size, and mtime.
  Its refs, including the now-stale `origin/main`, are unchanged.
- Two remotes with the same tag name keep separate tags.
- An `ext::` URL is rejected by Git before any command runs, and the marker file
  it would have created does not exist.

## Read-only reads

`tests/git/readers.test.ts` snapshots the repository and all its worktrees,
runs every reader, and requires the snapshot to be identical afterward. Adding
one real mutation (`git pack-refs --all`) makes that test fail, so the check can
detect change.

## Verification approach

Each reader is compared with ground truth from the fixture spec (parents, times,
messages) and with a different Git command than the one it uses:
`show-ref --dereference` for refs, `rev-parse HEAD` inside each worktree, and raw
commit parents against `rev-list` parents.

## Limits

- `rev-list` output is buffered whole (1 GiB cap). Streaming parse is a P1-E
  optimization if million-commit repositories need it.
- Non-UTF-8 commit encodings (the `encoding` header) are decoded as UTF-8 with
  replacement characters, not transcoded.
- Credential behavior (SSH agents, credential helpers, `gh auth setup-git`) is
  only exercised with local `file` transports in CI. P1-D includes the manual
  private-GitHub rehearsal.
