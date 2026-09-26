# 0012: Continuous local and remote monitoring (P1-D)

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 5.1, 5.2, 6, 9 (P1-D)

## Design

| Concern | Decision |
| --- | --- |
| Local changes | Filesystem watchers on ref metadata only: the common Git directory, `refs/` (recursive), `worktrees/` (recursive), and `reftable/`. Objects are not watched. Events are hints, debounced 250 ms. A reconcile timer (`monitor.localReconcileSeconds`) is the source of truth, and a failed watcher falls back to it silently. |
| Read scheduling | One read at a time per repository. Requests during a read merge into exactly one more read. Each caller waits only for the first read that started after its request (see the livelock below). |
| Revisions | A repository's revision changes only when what the graph depends on changed (ref and worktree targets, topology size, completeness), so quiet reconciles don't make clients refetch. |
| Remotes | Remote-only sources and a local source's `remotes` are fetched into `<cache>/repositories/<id>/objects.git` ([ADR 0008](0008-git-read-and-fetch-evidence.md) refspecs). Polling uses `remotePollSeconds` ±10% jitter, a global `maxConcurrentFetches`, and exponential backoff capped at 15 minutes after failures. Remote freshness (`remote.state`, `lastSuccess`, `nextAttempt`, diagnostic) is reported separately from local state. |
| Local + remote | The clone's tracking refs for a monitored remote are replaced by the cache's current refs, so a branch is never shown twice as "current". Commits from both are read in the cache with the clone's `objects/` added through `GIT_ALTERNATE_OBJECT_DIRECTORIES` for that process only. No alternates file is written, so either side's `git gc` stays safe. |
| Cache consistency | A per-repository cache lock serializes cache reads with fetches, and fetches with each other. |
| Restart | `meta.json` (written atomically) records the last successful fetch. After a restart, cached state is shown immediately as last-known; it is marked stale if the remote can't be reached, then re-verified. |
| Window rollover | Checked on every reconcile tick and by a timer set for the next local midnight, so sleep/resume and clock changes are covered. A `window` event makes clients refetch graphs. |
| Live transport | `GET /api/events` (server-sent events). Every message is the complete status list, so connecting or reconnecting is a full resync and nothing needs replay. Bursts are coalesced to one message per 100 ms, there's a 20 s heartbeat, and a client whose unsent buffer exceeds 256 KB is dropped (it reconnects and resyncs). The UI discards graph responses overtaken by newer ones, and resets its revision tracking on reconnect in case the service restarted. |
| Config reload | The config file's directory is watched, with a content-hash check every 5 s as backstop. Invalid edits keep the last valid config and show located errors in the UI. Valid edits add, remove, relabel, and retime sources without touching the others. `server.host`/`port` changes show a restart notice. |
| Diagnostics | Credential-bearing URLs are redacted. Authentication failures point to `git ls-remote` in a terminal. Unreachable remotes say so, and local monitoring continues. |

## Evidence

`tests/monitor/live.test.ts` runs the real app against a bare "server", a user
clone monitoring `origin`, a remote-only URL source, and a local-only
repository:

| Roadmap P1-D demonstration item | Result |
| --- | --- |
| Local commit, branch create/delete, tag create/delete, merge, worktree add/remove | Detected without reload; the merge shows both parent edges |
| Remote push | Remote-only and local+remote plots show the new tip; the clone's own `origin/main` is unchanged |
| Remote branch deletion and force-push | Deleted branch disappears; the force-pushed-away commit leaves the graph |
| Offline mode | Remote status becomes error with backoff; the remote-only plot keeps last-known state marked stale; local monitoring keeps working |
| Reconnect / recovery | The remote recovers on its own and the source returns to ready |
| SSE | First message is full state; later messages carry new revisions |
| Config reload | Invalid JSON → located error, config unchanged; valid edit adds and removes sources; host change → restart notice |
| Midnight expiry | Advancing the clock moves the window with no ref change; a `window` event fires and old commits leave the graph |
| Restart from cache | With the remote gone, a new service shows the cached graph immediately and reports it stale |
| No user-repository mutation | The monitored clone is byte-identical before and after all fetch cycles |

`tests/monitor/watch-reconcile.test.ts` shows watchers alone detect changes
(reconciliation set to one hour), and reconciliation alone detects them with
watchers off. `tests/server/events.test.ts` covers full resync on connect,
burst coalescing, and dropping non-reading clients.

Manual rehearsal (2026-09-26) against public GitHub over HTTPS: a remote-only
source for `defcello/git-garden` fetched and rendered in 1.6 s, and this
repository's own clone monitoring `origin` in 2.4 s, both ready.

## Bugs found by these tests

1. **Refresh livelock.** `refresh()` returned a promise for the whole read
   loop. With 1 s reconcile ticks and reads slower than 1 s, the loop never
   finished, so the remote fetch cycle waiting on it stalled forever. Callers now
   wait only for the first read that starts after their request.
2. **Lost update.** A read wrote back a view captured before it awaited Git,
   erasing remote status set meanwhile by a fetch. The view is now re-read at
   write time.
3. **Cache read/fetch overlap.** Reads and fetches of one cache could run
   concurrently. They are now serialized per repository.

## Not done here

- **Private GitHub rehearsal** needs a private repository and the maintainer's
  own credentials. It is left to the maintainer. Steps: add
  `{ "id": "private", "url": "https://github.com/<owner>/<private-repo>.git" }`,
  run `git-garden serve`, and check that the plot becomes ready. If it shows
  "authentication needed", `git ls-remote <url>` in a terminal should fail the
  same way.
- **Manual "retry now"** needs a mutating endpoint with a per-run capability
  token (roadmap section 13). Deferred to P1-E hardening. Backoff already caps
  at 15 minutes.
- **Remote tags on local+remote plots:** only the remote's branches are shown
  from the cache. Tags come from the clone, avoiding duplicate names across
  remotes. Remote-only plots show the remote's tags.
