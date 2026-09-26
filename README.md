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
| Git access | `src/git/`: shell-free Git calls with timeouts, output limits, and redacted errors; read-only readers for repository identity, refs, tags, worktrees, and commits; app-owned remote cache fetch |
| Demo fixtures | `tests/fixtures/`: deterministic repositories (fork/merge, old branch, three heads, criss-cross) |
| Ancestor selection prototype | `src/core/ancestor-anchors.ts`: exact common-ancestor anchors, checked against an independent oracle and Git ([evidence](docs/decisions/0007-ancestor-selector-evidence.md)) |
| Graph selection and static rendering | `src/core/`, `src/render/`: business-day window, visible commits with honest compressed edges, deterministic layout, technical SVG ([example](docs/decisions/assets/garden-tour.svg)) |
| Configuration and service | `git-garden init-config`, `validate-config`, `serve`: strict versioned config ([schema](git-garden.schema.json), [example](git-garden.example.json)); a loopback-only server that re-reads repositories every few seconds |
| Interactive technical view | Browser UI: garden of repository plots, circular `+`/`−` focus, hover tooltips, pinned commit details, pan/zoom, keyboard and touch support ([ADR 0011](docs/decisions/0011-interactive-technical-renderer.md)) |
| Live monitoring | Watchers plus periodic reconciliation for local repositories; remote-only `url` sources and `remotes` of local clones fetched into a private cache; live updates over server-sent events; configuration reload ([ADR 0012](docs/decisions/0012-continuous-monitoring.md)) |
| Garden art | Planned; see roadmap Phase 2 |

## Trying it

```sh
npm ci
node src/cli.ts init-config --config my-garden.json   # then add repositories
node src/cli.ts validate-config --config my-garden.json
npm run build                                         # builds the browser UI into dist/ui
node src/cli.ts serve --config my-garden.json         # open http://127.0.0.1:4783/
```

Each repository entry has an `id` and either a local `path` or a remote `url`.
Relative paths are resolved against the configuration file. Without `--config`,
git-garden uses the per-user file (`%APPDATA%\git-garden\config.json` on Windows,
`~/Library/Application Support/git-garden/config.json` on macOS,
`$XDG_CONFIG_HOME/git-garden/config.json` on Linux).
Local repositories update within moments of a commit (file watching, backed by a re-read every `monitor.localReconcileSeconds`). Remotes (`url` sources, or `"remotes": ["origin"]` on a local repository) are fetched every `monitor.remotePollSeconds` into git-garden's own cache, using your existing Git credentials; your clones are never fetched into or changed. Edits to the configuration file apply while running. A static view without JavaScript is at `/preview`.

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
| `npm run test:e2e` | Browser tests with Playwright, using installed Chrome or Edge (build first) |
| `npm run dev:ui` | Vite dev server for the UI, proxying `/api` to a running service |
| `npm run lint` | ESLint with type-aware rules |
| `npm run typecheck` | TypeScript over sources and tests |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run format` | Apply Prettier formatting |
| `npm run fixture -- <name> [dir]` | Write a demo repository to `tmp/fixtures/<name>` (or `dir`) to look at |
| `npm run bench:ancestors` | Benchmark the ancestor selector (`-- --quick` for a smoke run) |
| `npm run render:fixture -- <name> <now> <out.svg>` | Render a demo repository to a static SVG as of a given time |
| `npm run bench:graph` | Benchmark the full pipeline on a long quiet history (`-- --quick` for a smoke run) |

Demo fixture names: `forkMerge`, `oldBranchHead`, `threeHeads`, `crissCross`, `gardenTour`. For
example, `npm run fixture -- crissCross` followed by
`git -C tmp/fixtures/crissCross log --graph --oneline --all`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
