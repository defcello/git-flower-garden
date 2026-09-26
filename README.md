# git-garden
Visualize Git activity as a garden of commits.

git-garden is in early development. It cannot visualize a repository yet. The
[roadmap](ROADMAP.md) describes the architecture, Git graph semantics,
implementation phases, and acceptance criteria. It also lays out the path from a
real-time technical view to a living garden.

## What exists today

| Area | Status |
| --- | --- |
| Design and semantics | Documented in [ROADMAP.md](ROADMAP.md) and [architecture decisions](docs/decisions/) |
| Toolchain and CI | TypeScript, lint, format, unit tests on Windows, macOS, and Linux |
| Git subprocess wrapper | `src/git/`: shell-free Git calls with timeouts, output limits, and redacted errors; Git version check |
| Demo fixtures | `tests/fixtures/`: deterministic repositories (fork/merge, old branch, three heads, criss-cross) |
| Ancestor selection prototype | `src/core/ancestor-anchors.ts`: exact common-ancestor anchors, checked against an independent oracle and Git ([evidence](docs/decisions/0007-ancestor-selector-evidence.md)) |
| Graph selection, monitoring, UI, garden art | Planned; see roadmap Phases 1 and 2 |

## Contributor setup

Requirements: [Node.js](https://nodejs.org/) 24 or newer (see `.nvmrc`) and
[Git](https://git-scm.com/) 2.36 or newer.

```sh
npm ci           # install exact dependency versions
npm run check    # format check, lint, typecheck, build, and tests
```

Individual commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run unit and Git fixture tests once (`npm run test:watch` to watch) |
| `npm run lint` | ESLint with type-aware rules |
| `npm run typecheck` | TypeScript over sources and tests |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run format` | Apply Prettier formatting |
| `npm run fixture -- <name> [dir]` | Write a demo repository to `tmp/fixtures/<name>` (or `dir`) to look at |
| `npm run bench:ancestors` | Benchmark the ancestor selector (`-- --quick` for a smoke run) |

Demo fixture names: `forkMerge`, `oldBranchHead`, `threeHeads`, `crissCross`. For
example, `npm run fixture -- crissCross` followed by
`git -C tmp/fixtures/crissCross log --graph --oneline --all`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
