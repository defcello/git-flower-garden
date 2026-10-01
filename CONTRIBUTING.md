# Contributing to git-flower-garden

Thank you for your interest. git-flower-garden is an independent, MIT-licensed personal
open-source project. It is not affiliated with, sponsored by, or endorsed by any
employer, animation studio, or Git hosting provider.

## Before you start

1. Read [ROADMAP.md](ROADMAP.md), especially section 15, "Working agreement". Find
   the earliest incomplete gate in its completion ledger. The plan describes future
   work; check the code for what actually exists.
2. For anything beyond a small fix, open an issue first so the approach can be
   agreed before you write a lot of code.
3. Changes to a documented contract (Git semantics, configuration, data
   records) need a new record in [docs/decisions/](docs/decisions/). Update the
   roadmap, examples, and tests in the same change.
4. Third-party code that ships to users is never installed from a package
   registry. It is pinned in `vendor/` as a Git submodule at a reviewed commit,
   with a security review record and checksum tests
   ([ADR 0019](docs/decisions/0019-astronomy-engine-review.md)). Moving a pin
   needs a new review.

## Development setup

Requirements: [Node.js](https://nodejs.org/) 24 or newer (see `.nvmrc`) and
[Git](https://git-scm.com/) 2.36 or newer.

```sh
git clone --recurse-submodules https://github.com/defcello/git-flower-garden.git
npm ci           # install exact dependency versions
npm run check    # format check, lint, typecheck, build, and tests
```

In an existing clone, `git submodule update --init` fetches the one
submodule: astronomy-engine, pinned to a reviewed release in
`vendor/astronomy-engine` ([ADR 0019](docs/decisions/0019-astronomy-engine-review.md)).
After pulling a change that moves it, run the same command again.

Individual commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run unit and Git fixture tests once (`npm run test:watch` to watch) |
| `npm run test:e2e` | Browser tests with Playwright, using installed Chrome or Edge (build first); set `GARDEN_E2E_CHANNEL=chromium` after `npx playwright install chromium` when a system browser is unavailable |
| `npm run dev:ui` | Vite dev server for the UI, proxying `/api` to a running service |
| `npm run lint` | ESLint with type-aware rules |
| `npm run typecheck` | TypeScript over sources and tests |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run format` | Apply Prettier formatting |
| `npm run fixture -- <name> [dir]` | Write a demo repository to `tmp/fixtures/<name>` (or `dir`) to look at |
| `npm run bench:ancestors` | Benchmark the ancestor selector (`-- --quick` for a smoke run) |
| `npm run render:fixture -- <name> <now> <out.svg>` | Render a demo repository to a static SVG as of a given time |
| `npm run bench:graph` | Benchmark the full pipeline on a long quiet history (`-- --quick` for a smoke run) |
| `npm run bench:live` | Measure detection latency, startup, idle CPU, and memory of the live service |
| `npm run rehearse:install` | Pack, install into an empty project, and exercise the installed CLI (build first) |

Demo fixture names: `forkMerge`, `oldBranchHead`, `threeHeads`, `crissCross`, `gardenTour`. For
example, `npm run fixture -- crissCross` followed by
`git -C tmp/fixtures/crissCross log --graph --oneline --all`.

## Making a change

```sh
git submodule update --init   # vendor/astronomy-engine, pinned (ADR 0019)
npm ci
npm run check
```

`npm run check` must pass. CI runs it on Windows, macOS, and Linux.

- Keep changes small and demonstrable. Every increment should leave something that
  runs and is tested.
- Tests must check real behavior. Build Git scenarios with the fixture builder in
  `tests/fixtures/` using fictional names, messages, and fixed dates. Tests must
  never need a private repository, credentials, network access, or paid service.
- Never add code that mutates a monitored repository or the user's Git
  configuration ([ADR 0002](docs/decisions/0002-read-only-source-policy.md)).
- Call Git through `src/git/run-git.ts` with argument arrays, never through a shell.
- Treat commit messages, ref names, and paths as untrusted text.
- Check a roadmap box only when its deliverable exists and its verification
  passes. Record evidence in the completion ledger.

## Artwork and third-party material

Add only original work or material whose license allows redistribution under this
project's terms. Record the source, author, and license of every asset. Do not
imitate the characters or scenes of existing films or studios.

## Conduct

Be kind and assume good faith. Critique ideas and code, not people.
