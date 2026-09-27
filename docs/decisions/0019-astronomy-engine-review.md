# 0019: astronomy-engine as a pinned submodule, and its security review

- Status: Accepted (review passed with the conditions below)
- Date: 2026-09-27
- Roadmap: section 10 (P2-D)
- Related: [ADR 0018](0018-two-tier-scene-renderer.md) (why and where it is
  used)

## Decision

[astronomy-engine](https://github.com/cosinekitty/astronomy) (Don Cross,
MIT) computes sun and moon positions. It is included as a **Git submodule**
at `vendor/astronomy-engine`, cloned shallow and pinned to commit
`61dc07020aaa6885d2c7f688a4d82beaf6edb9ef`, the target of release tag
`v2.1.19` (2023-12-14). It is never installed from npm.

A submodule rather than a subtree: the upstream repository is about 53 MB
and covers eight languages, demos, and code generators. A subtree would copy
all of it into this repository's history; a submodule records one commit id.

Code reaches it only through `src/environment/astronomy.ts`, by the
`#astronomy-engine` alias in `package.json` `imports`: types from
`source/js/astronomy.d.ts`, code from `source/js/esm/astronomy.js`. ESLint
rejects the import anywhere else in `src/`.

## Files in use and their hashes

`tests/environment/astronomy.test.ts` checks these SHA-256 values, so moving
the submodule without a new review fails the tests:

| File | Role | SHA-256 |
| --- | --- | --- |
| `source/js/esm/astronomy.js` | Code that is bundled | `068f1445ed0c636c94818fe6d20d7d125120e605e0bab9fc4675c3d531be5ad7` |
| `source/js/astronomy.d.ts` | Types | `fc5f1ede68dbebc32ce2f3f878cb3b261dc1bf8c16422451f0c4092c41fc871e` |
| `source/js/astronomy.ts` | Source both are compiled from; what was reviewed | `e043bba40da82c981d2952407c68975b60cd9d94675c91e1c0d3c8c148595fb3` |
| `LICENSE` | MIT notice | `690dd98cb13ba4db77c6327deea852a816892bb9debbad5943405c66972f8023` |

Nothing else in the submodule is built, run, or bundled. Its `generate/`
tooling and `package-lock.json` are never installed or executed.

## Review

Method and findings, in the order performed:

1. **Provenance.** MIT license, compatible with this project's. One primary
   maintainer (about 2,100 of the commits). No published GitHub security
   advisories. The release tag is annotated but **unsigned**, so the pin is
   the commit id, not the tag name: a moved or re-created tag cannot change
   what is checked out.
2. **Generated source against its template.** `astronomy.ts` is produced
   from the hand-written `generate/template/astronomy.ts` by filling six
   data slots. A line diff shows the files identical everywhere else. The
   inserted lines hold only numeric tables, 104 calls of `AddSol(...)` with
   numeric arguments (a function defined in the template), table
   declarations, and 174 constellation names; every identifier in them was
   listed and is a data name. So the review reduces to the hand-written
   template.
3. **Capabilities.** With comments and string literals removed, both
   `astronomy.ts` and the bundled `esm/astronomy.js` were searched for
   network access (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
   `sendBeacon`), dynamic code (`eval`, `Function`, string timers, `import`,
   `require`), browser and host access (DOM, storage, `navigator`,
   `location`, `globalThis`, `self`, `process`, `fs`), prototype or built-in
   mutation, `Proxy`, `Reflect`, `defineProperty`, and decoding tricks
   (`atob`, `fromCharCode`, `unescape`). **None found.** The only I/O is
   `console.trace()` in two input-validation helpers, just before they
   throw.
4. **Hidden content.** No bidirectional-override or zero-width characters;
   the only non-ASCII characters are α and δ in one comment. No encoded
   blobs; the longest string literal is an error message. Every URL is a
   citation in a comment.
5. **Import-time behavior.** Every top-level statement is a declaration;
   importing the module runs no code. Module-level mutable state is limited
   to internal caches, a `CalcMoonCount` statistics counter, and the
   Delta T model, changeable only by the exported `SetDeltaTFunction`, which
   this project does not call. The package declares `sideEffects: false`.
6. **Compiled output matches the reviewed source.** Recompiling
   `astronomy.ts` with upstream's settings (TypeScript 6.0.3 here; upstream
   used 4.1) reproduces `esm/astronomy.js` and `astronomy.d.ts`. After
   whitespace is normalized, the only differences are trailing comments on
   ten enum lines and a `declare` keyword on two type aliases, which are
   compiler-version details. The review of the source therefore covers
   the bundled file.
7. **Termination and error behavior.**
   - Searches are bounded by iteration limits or a caller-given time window.
   - **Three exported functions can loop forever on a non-finite number**:
     `SearchRiseSet` with `limitDays` of `NaN` when no rise or set occurs
     (polar day or night), `InverseRefraction(NaN)`, and
     `AstroTime.FromTerrestrialTime(NaN)`. Dates and observer coordinates
     are validated by the library itself (`AstroTime`, `VerifyObserver`);
     these three numeric arguments are not.
   - It throws **string values, not `Error` objects** (103 sites).
   - It is CPU-only; with valid inputs a call costs microseconds to
     milliseconds, and nothing retains memory beyond the small caches.
8. **Exposure through this project's tools.** ESLint and Prettier ignore
   `vendor/`; Vitest only collects `tests/**/*.test.ts`; TypeScript reads
   the `.d.ts` only. No install script, build step, or test in the
   submodule runs.

Result: **no malicious or network-capable code found.** Accepted with the
conditions below.

## Conditions

1. **One import site.** Only `src/environment/astronomy.ts` imports the
   library (ESLint `no-restricted-imports`). It validates time and place
   and throws `RangeError` before any library call, so the non-finite hangs
   in finding 7 cannot be reached through it. New wrapper functions must
   validate the same way, and must not pass caller-supplied `limitDays`.
2. **Catch strings.** Wrapper code treats any thrown value as an error, not
   only `Error` instances.
3. **Ship the license notice.** The bundler strips upstream's `@preserve`
   header. Before the UI first bundles this library (ADR 0018 step 1), the
   MIT notice must reach users, by keeping legal comments in the build or
   shipping a third-party notices file in the package, with a check in
   `scripts/stage-release.ts`. *Met (2026-09-27):* the staged package
   includes `THIRD-PARTY-NOTICES.md`, generated from the vendored `LICENSE`
   (and React's), and staging fails if a notice is missing or not MIT.
4. **Upgrades are reviews.** To move the pin: check out the new commit,
   repeat steps 1 to 8 on the diff from `61dc070` (the template diff and
   capability search are the quickest high-value checks), rerun the
   reference-case tests, update the hashes above and in the test, and add
   the findings to this record or a new one.

## Residual risks

- **Single maintainer, quiet since 2025.** Acceptable for stable,
  self-contained numerical code; there is no network surface to keep
  patched.
- **Availability.** If the upstream repository disappeared, fresh clones
  could not fetch the submodule. Existing clones keep it; a mirror under
  `defcello/` would restore it by changing the submodule URL.
- **SHA-1 commit ids.** The gitlink is SHA-1 (collision-hardened in Git);
  the SHA-256 file hashes above are a second, independent pin.

## Verification

`tests/environment/astronomy.test.ts`:

- the four file hashes;
- the 2024 March equinox and June solstice, the 2024-04-08 new moon, and
  the 2024-01-25 full moon, each within two minutes of the published time;
- no sunset during polar day at Longyearbyen;
- the wrapper: solstice sun at the axial tilt above the North Pole, the
  equinox noon sun overhead at the equator, moon phase and lit fraction at
  new and full moon, azimuth measured clockwise from north, and `RangeError`
  on each kind of invalid input.

The current wrapper bundles to about 75 KB minified (25 KB gzipped) of the
library's 135 KB, measured with a Vite library build.
