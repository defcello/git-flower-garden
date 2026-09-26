# Contributing to git-garden

Thank you for your interest. git-garden is an independent, MIT-licensed personal
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

## Making a change

```sh
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
