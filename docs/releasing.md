# Releasing

For maintainers. Users install the staged package; nothing here ships in it.

## What the package contains

`npm run release:stage` writes `release/stage/` and packs it to
`release/<name>-<version>.tgz`:

- compiled JavaScript without source maps, type declarations, or comments;
- the built browser UI;
- an end-user README (`docs/package-readme.md`), the user guide, the
  changelog, the license, and the configuration schema and example;
- a `package.json` with no scripts, dependencies, or development metadata.

It refuses to pack if the staged files contain source maps, type
declarations, local user paths, the checkout path, test or tooling names, or
roadmap references, or if the docs name the wrong npm package. The package
name (`@defcello/git-flower-garden`), links, and version come from
`package.json`; the command is always `git-garden`. The README's install
command is this release's download link, so the tarball name is checked
against it. (The unscoped npm name `git-garden` belongs to an unrelated tool.)

`npm run rehearse:install` then installs it globally into a scratch npm
prefix and home, runs init, validate, serve, and demo, updates to a newer
version, cleans the cache, uninstalls, and fails if anything but the
configuration file is left. CI runs both on Windows, macOS, and Linux.

## Cutting a release

1. Set `version` in `package.json` and date the `CHANGELOG.md` section.
2. `npm run check`, commit, and push to main.
3. Tag and push the tag: `git tag -a v<version> -m "git-garden <version>"`,
   `git push origin v<version>`.
4. The `release` workflow checks the tag against `package.json`, rehearses
   on every OS, and creates a **draft** pre-release with the package and its
   SHA-256. Review it, then publish it on GitHub.
5. Releases are GitHub release files only. The staged package is marked
   `private`, so an accidental `npm publish` fails; publishing to npm would
   be a separate decision (remove `private` and add a publish step).
