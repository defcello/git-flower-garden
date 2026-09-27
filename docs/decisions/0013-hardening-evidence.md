# 0013: Hardening and the v0.1.0 functional preview (P1-E)

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 9 (P1-E), 12, 13

## Performance (roadmap section 12)

`npm run bench:live`: 10 repositories, production intervals (5 s
reconciliation), 20 changes per mode. Machine: Intel Core m3-7Y30 (2 cores /
4 threads, 1.0 GHz), 4 GB RAM, Windows 10, Node 24.18.0, Git 2.55. This is
below the roadmap's baseline machine and carried 20–45% background load from
other programs while measuring.

| Measurement | Result | Roadmap target |
| --- | --- | --- |
| Startup: first repository ready (the page is served before any read) | 856 ms | first cached view <= 2 s |
| Startup: every repository read, with its first graph | 4.6 s | (no separate target) |
| Detection with watchers, p50 / p95 (n=20) | 892 ms / 915 ms | p95 <= 2 s |
| Detection by reconciliation only, p50 / p95 | 4.4 s / 4.7 s | <= 7 s |
| Incremental graph build, p50 / p95 | 2 ms / 3 ms | p95 <= 500 ms |
| Idle CPU over 60 s, whole machine including Git processes, minus baseline | within noise of baseline (−1.4 to +0.7 % across runs) | < 2 % (service + UI) |
| Memory (service process RSS) | 71 MiB | < 500 MB (service + browser) |

Earlier results: [ADR 0010](0010-quiet-history-and-pipeline-benchmark.md)
(100k-commit cold read and selection about 3.3 s; layout a few milliseconds)
and [ADR 0007](0007-ancestor-selector-evidence.md) (ancestor selection at the
stress size).

### Found and fixed while measuring

The first full run showed the whole machine 100% busy with the service
"idle", and detection p95 at 6.6 s. Three causes, all fixed:

1. **Self-triggering watch loop (Windows).** libuv's directory watcher also
   reports last-access-time changes, so Git's own reads of `packed-refs` and
   refs set off another read. Watch events now only lead to a read when a
   stat fingerprint of the ref metadata (sizes, modification times, directory
   listings; `src/monitor/probe.ts`) has changed.
2. **Reconcile pile-up.** A tick that found a read in progress queued another
   read. Where reads take longer than the tick, a repository read forever.
   Ticks now skip while a read runs; the next tick compares fingerprints.
3. **Git processes per reconcile.** Each reconcile tick started about 12 Git
   processes per repository. Now a tick is a stat fingerprint, and a Git read
   happens only when it changed, plus a full read every 5 minutes as a
   backstop for coarse filesystem timestamps and changes outside `.git`. A read
   proves coherence by an unchanged fingerprint instead of re-reading all refs,
   and concurrent reads are bounded (half the logical CPUs, at least 2).

`tests/monitor/watch-reconcile.test.ts` shows idle ticks start no Git process,
changes are still detected, and the full-read backstop still runs.
`tests/git/snapshot.test.ts` shows a changing fingerprint falls back to
verifying by re-reading.

## Correctness (roadmap section 12 fixture table)

| Fixture / event | Where tested |
| --- | --- |
| Empty / unborn repository | `server.test.ts` (empty repo), `readers.test.ts` (unborn worktree) |
| Linear history with years of old commits | `visible-graph.test.ts` (oldBranchHead), `bench-graph.ts` |
| Old divergent branch and ancestor | `visible-graph.test.ts`, `snapshot.test.ts` (gardenTour) |
| Two refs on one OID | `visible-graph.test.ts`, browser test "several refs…" |
| Head ancestral to another head | `ancestor-anchors.test.ts` |
| Three or more heads | `ancestor-anchors.test.ts` (oracle, 2,000 DAGs; Git cross-check) |
| Criss-cross merges | `ancestor-anchors.test.ts`, `builder.test.ts` |
| Octopus merge | `ancestor-anchors.test.ts`, `visible-graph.test.ts` |
| Unrelated histories | `ancestor-anchors.test.ts`, `visible-graph.test.ts` |
| Old parent with recent ancestor timestamp | `visible-graph.test.ts` (timestamp inversion) |
| Monday / weekend / custom weekdays / DST | `business-days.test.ts` (minute-by-minute oracle) |
| Window changes without new commits | `live.test.ts` (midnight), `repository-service.test.ts` |
| Annotated / lightweight / moved / deleted / non-commit tags | `readers.test.ts`, `live.test.ts`, `remote-cache.test.ts` |
| Attached / detached / locked / prunable worktrees | `readers.test.ts`, `live.test.ts` (add/remove) |
| Linked worktree config path | `readers.test.ts`, `server.test.ts` (duplicate repository) |
| SHA-256 repository | `snapshot.test.ts`: a SHA-256 build of gardenTour gives 64-character IDs and the same graph as SHA-1 |
| Shallow / missing-object history | `readers.test.ts`, `snapshot.test.ts`, `visible-graph.test.ts` (oracle) |
| Force push / branch delete | `live.test.ts`, `remote-cache.test.ts` |
| Authentication / network failure | `live.test.ts` (offline and recovery); diagnostic wording in `repository-service.ts` |
| Rapid mutation during reading | `snapshot.test.ts` (fingerprint changes mid-read → verified re-read) |
| Watcher misses an event | `watch-reconcile.test.ts` (watchers off) |
| SSE disconnect / slow client | `events.test.ts` |
| Invalid / changed config | `config.test.ts`, `live.test.ts` (reload) |
| Untrusted message / ref text | `layout-svg.test.ts`, `server.test.ts`, browser tests |
| Garden versus technical renderer | Phase 2 |

## Security (roadmap section 13)

| Requirement | Status |
| --- | --- |
| Loopback only by default; non-loopback rejected | Config validation (`config.test.ts`) |
| Host/Origin validation, no permissive CORS | `server.test.ts` (421 for foreign Host, 403 cross-origin, no CORS headers, CORP same-origin) |
| Session capability for sensitive or mutating routes | No such routes exist: the API is read-only (GET/HEAD; others get 405). A future "retry now" needs one. |
| No request chooses a path, command, executable, or URL | Routes take only configured IDs and hex OIDs; static files come from a fixed in-memory map |
| Escape repository text; CSP | React text rendering; SVG escaping tests; CSP `script-src 'self'` |
| No source mutations, hooks, or global config/credential changes | Byte-for-byte snapshot tests (`readers`, `remote-cache`, `live`, `server`) |
| Private cache data in per-user locations; no encryption claim | `src/config/paths.ts`; user guide states retention and cleanup |
| Redacted secrets and URLs in diagnostics; no telemetry | `redactCredentials` on every diagnostic; nothing is sent anywhere but fetches |
| Bounded config, subprocess output/time, event queues | 1 MiB config, runGit limits, 256 KB per SSE client |
| Port conflict diagnostic; clean shutdown | `server.test.ts`; `stop()` aborts fetches and closes watchers and SSE clients |
| GitHub integration optional | Only plain Git transports are used |

## Operations

- `git-flower-garden demo`: fictional repositories, no credentials or network.
- `git-flower-garden status` and `GET /api/diagnostics`: freshness, fetch failures,
  counts, read, graph, and fetch timings, and cache sizes.
- `git-flower-garden cache [--clean <id> | --clean-all]`: cache sizes, flags caches
  of repositories no longer configured, and explicit cleanup limited to
  app-owned directories.
- Progressive startup: the page is served at once, and repositories fill in.
- [User guide](../user-guide.md): install, start/stop, configuration
  reference, authentication troubleshooting, supported sizes, and known
  limitations.
- Packaging: no runtime dependencies (the UI ships prebuilt). `npm run
  rehearse:install` packs the project, installs the tarball into an empty
  project, and runs the installed CLI (`--version`, `init-config`,
  `validate-config`, `serve`, `demo`). CI runs it on Windows, macOS, and Linux.

## Soak

`node scripts/soak.ts 8 <log>`: 10 local repositories and a remote-only source.
Every 20 s there's a commit or branch change, every 2 minutes a remote push,
and every hour a 3-minute remote outage. An SSE client reconnects every 10
minutes, and memory, handles, reads, and errors are sampled every minute.

Result (2026-09-26 17:31 to 2026-09-27 01:30, the v0.1.0 server code, on the
2-core Core m3 laptop, which was also running builds and browser tests for
much of the time): **passed.**

| Measure | Result |
| --- | --- |
| Changes applied | 1,661 commits, branch moves, and pushes; 3,206 repository reads; 3,709 events delivered |
| Event stream | 0 errors across 48 reconnects |
| Errors | 14 push failures and 15 fetch failures, every one inside a scheduled remote outage |
| Recovery | "Not ready" samples only in the 8 outage windows (3–4 samples each); every source was ready again within a minute of the remote returning |
| Heap | 9.4–21.4 MiB throughout; hourly peak 21.4 MiB in the first hour, 17.1–17.7 MiB in every later hour |
| Resident memory | Hourly medians 37.7, 44.0, 44.7, 44.9, 43.7, 44.2, 29.8, 28.3 MiB (72 MiB only at startup) |
| Handles | At most 12 active; no growth |

No listener, handle, or memory growth; the final sample had all 11 sources
ready. The log is `tmp/soak/soak-8h.jsonl` (not committed).

## Gap found later: interaction at the 2,000-node envelope

The roadmap's interaction target (input response ≤ 100 ms, ≥ 30 fps pan/zoom)
was not measured in P1-E. Measured during the P2-A review, a focused graph of
2,000 visible commits takes about 0.2–0.4 s per zoom step in the technical
view on the Core m3 laptop ([ADR 0015](0015-botanical-renderer-proof.md)). The
target is not met at that size. Typical repositories (tens to hundreds of
visible commits) are unaffected.

Resolved for realistic histories by [ADR 0016](0016-focus-view-culling.md):
with row culling and level of detail, a tall 2,000-commit history now takes
about 33 ms per zoom step (the two-frame floor) in every renderer on the
same laptop.

## Not verified by me

- **Sleep/resume on real hardware.** The logic (window recompute on every
  tick, fingerprint and full-read reconciliation, fetch backoff) is tested with
  clock jumps and outages, but I did not suspend the maintainer's machine.
- **Clean install on physical macOS and Linux machines.** CI runs the
  install rehearsal on GitHub's runners for all three systems.
- **Private GitHub repository** (see [ADR 0012](0012-continuous-monitoring.md)).
