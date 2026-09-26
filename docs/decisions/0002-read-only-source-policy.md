# 0002: Monitored repositories are read-only

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 1 (principle 3), 5.1, 13

## Context

Users will point git-garden at working clones that hold uncommitted work. A
monitor that fetched, pruned, or repaired those clones could move their
remote-tracking refs, delete branches they rely on, or race with their own Git
commands. Hooks and repository-provided configuration could execute code.

## Decision

git-garden never mutates a monitored repository or the user's Git setup:

- No checkout, pull, push, commit, reset, fetch, prune, gc, or deepening in a user
  clone. No changes to files, the index, refs, hooks, worktrees, or config.
- No changes to global or system Git configuration or credential stores.
- Remote state comes from `git fetch` into app-owned bare repositories kept in a
  per-user cache directory outside monitored workspaces. Cleanup is limited to
  those app-owned directories.
- Git runs directly with argument arrays (never through a shell), with bounded
  output, timeouts, and noninteractive prompts (`GIT_TERMINAL_PROMPT=0`).
  `src/git/run-git.ts` implements this.
- Repository text (messages, ref names) is displayed as text, never markup.

## Consequences

- Remote-tracking refs read from a user clone show its *last fetched* state and
  are labelled that way; current remote state needs the app-owned cache.
- Shallow clones show an explicit history boundary instead of being deepened.
- The cache holds private repository data and must be documented, bounded, and
  removable.
- Tests must check before/after state of monitored fixtures, not assume safety.

## Revisit

Only through a new ADR for an explicit, user-invoked feature. Background
monitoring stays read-only.
