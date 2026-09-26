# 0006: Toolchain baseline

- Status: Accepted
- Date: 2026-09-26
- Roadmap: section 3, P0-A

## Context

The roadmap asks P0-A to pin supported Node.js and Git versions after checking
capabilities, and to set up strict TypeScript, formatting, linting, building, and
testing that work the same way on Windows, macOS, and Linux.

## Decision

| Tool | Pinned | Why |
| --- | --- | --- |
| Node.js | 24 (`.nvmrc`, `engines: >=24`, `engine-strict`) | Active LTS in September 2026. Runs erasable TypeScript directly, so scripts need no build step. |
| npm | lockfile committed; CI uses `npm ci` | Reproducible installs. |
| TypeScript | 6.0.3, `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` | TypeScript 7.0 is released, but typescript-eslint 8.70 supports only `<6.1`. Move to 7 when typed linting supports it. |
| ESLint | 10 with typescript-eslint `strictTypeChecked` | Type-aware rules catch floating promises and unsafe `any`. |
| Prettier | 3.9 | Formats code and config. Markdown is excluded because table realignment makes prose diffs noisy. |
| Vitest | 5.0 | Runs TypeScript tests without a separate build. |
| Git | 2.36 or newer | See below. |

Imports use `.ts` extensions (`allowImportingTsExtensions` with
`rewriteRelativeImportExtensions`), so the same sources run under Node's type
stripping and compile to `dist/` with `tsc`.

### Git capability floor

Git features in use or planned for Phase 1:

| Capability | Introduced |
| --- | --- |
| `--object-format` for SHA-256 test repositories | 2.29 |
| `GIT_CONFIG_GLOBAL` (fixture isolation from user config) | 2.32 |
| `git worktree list --porcelain -z` | 2.36 |
| `merge-base --all --octopus`, `for-each-ref`, `cat-file --batch`, `commit-tree` | long-standing |

`src/git/version.ts` sets `MINIMUM_GIT_VERSION = 2.36.0`, and a test fails if the
installed Git is older. Development observed Git 2.55.0.windows.3 and Node 24.18.0.

### Cross-platform notes

- `.gitattributes` forces LF so formatting checks and fixture content match on Windows.
- Git for Windows rejects Node's `os.devNull` (`\\.\nul`) as a config path but
  accepts `/dev/null`, so fixtures use `/dev/null` on every OS.
- Demo fixtures are built with plumbing (`hash-object`, `mktree`, `commit-tree`)
  and pinned identities and dates. A golden object ID in
  `tests/fixtures/builder.test.ts` fails if any OS or local configuration changes
  the result.

## Consequences

- CI runs `npm run check` on Ubuntu, Windows, and macOS.
- Browser testing arrives with the first UI ([0005](0005-initial-rendering-stack.md)).

## Revisit

When typescript-eslint supports TypeScript 7, when Node.js 26 becomes Active LTS
(October 2026), or if a required Git capability raises the floor.
