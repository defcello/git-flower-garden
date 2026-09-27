# git-garden roadmap

Status: Phase 1 complete in code, including optional GitHub push notifications (P1-F). The 8-hour soak passed (ADR 0013); v0.1.0 is tagged. Open: maintainer rehearsals (private GitHub, real webhook, physical sleep/resume), and the 2,000-node interaction target (not met, ADR 0015). Phase 2: P2-A review candidate reviewed and corrected; the maintainer's visual and asset-licensing review is the gate. Updated: 2026-09-27.

This document is the implementation contract for future sessions and contributors. It takes the repository from its initial README and MIT license to a reliable, beautiful, continuously updated garden of Git repositories. Checkboxes describe future work, not completed capabilities. Milestones are dependency gates, not calendar promises.

Navigation: [Git/time semantics](#4-exact-git-and-time-semantics) · [Architecture](#5-service-architecture-and-data-contracts) · [Configuration](#6-configuration-contract) · [Interactions](#7-interaction-and-layout-contract) · [Foundation](#8-phase-0--foundation-and-executable-specifications) · [Functional release](#9-phase-1--reliable-real-time-gitk-style-visualization) · [Living garden](#10-phase-2--the-living-garden) · [Public release](#11-phase-3--sustainable-public-release) · [Verification](#12-verification-strategy-and-performance-targets) · [Future sessions](#15-working-agreement-for-future-implementation-sessions).

## 1. Product vision and boundaries

Run git-garden on a dedicated monitor and see the life of one or many repositories. Each repository occupies one plot. Commits grow upward, branches diverge, merges reconnect, tags mark releases, and worktree indicators show local checkouts. Hovering or selecting reveals the real Git information underneath the picture. A circular `+` above a hovered tree focuses that repository; a circular `-` returns to the whole garden.

Deliver the functional graph first. Then give that same graph the appearance of flowering bushes on a manicured hill, backed by the Blue Ridge Mountains and a living sky. Aim for the warmth, dimensional lighting, and playful realism of a high-quality animated film, using original art and mostly pre-rendered components rather than a full 3D world.

Product principles:

1. **Git truth comes first.** A beautiful image must not invent a branch, merge, commit, or current remote state.
2. **Local ownership.** No git-garden account, hosted service, telemetry, or paid service is required for the core product. Users supply their own repository access through Git and, optionally, GitHub CLI.
3. **Observe safely.** Do not checkout, pull, push, commit, reset, modify files, install hooks, or prune worktrees in monitored repositories. Network fetches write only to app-owned caches.
4. **A calm, legible monitor.** Stable placement, restrained motion, clear freshness, and useful inspection matter more than constant animation.
5. **One graph, multiple renderers.** The technical view remains available after the garden ships, and provides a diagnostic comparison.
6. **Sustainable open source.** Preserve the existing MIT license. Track third-party code and artwork licenses. Keep contributor setup and operating cost small enough for a personal project.

Initial scope excludes a Git editor, diff/merge conflict UI, code hosting, CI dashboard, historical playback, collaboration service, productivity rankings, full 3D simulation, and remote worktree discovery. GitHub cannot report another computer's local worktrees. Such features need separate proposals after the core vision works.

## 2. Requirements and release gates

| ID | Required behavior | Verification gate |
| --- | --- | --- |
| R01 | Monitor one or many configured local paths and remote URLs | P1-D: mixed-source garden, failure isolation |
| R02 | Every in-scope branch head has a commit node, even when old | P1-B: exact selection assertions |
| R03 | Preserve best common ancestors for every combination of branch heads | P1-B: subset oracle and criss-cross fixtures |
| R04 | Preserve every in-scope commit in the configurable recent business-day window | P1-B: calendar and skewed-date fixtures |
| R05 | Reflect local commits, refs, tags, and worktrees without manual refresh | P1-D: mutation-to-screen tests |
| R06 | Reflect remote changes automatically; support push notifications where practical | P1-D polling; P1-F optional webhook integration |
| R07 | Hover and click expose messages, tags, and branch names | P1-C: mouse, touch, and keyboard tests |
| R08 | Circular `+` above a tree focuses it; `-` restores the garden | P1-C: view state and camera restoration tests |
| R09 | User-editable configuration; user's existing Git authentication | P1-A/P1-D: schema, reload, private-repo manual test |
| R10 | Quiet repositories stay visually short without losing required nodes | P1-B/P1-C: old-history compaction fixture |
| R11 | Commits become knots/leaves, heads flowers, tags fruit, edges stems | P2-B: semantic parity with technical view |
| R12 | Hill, Blue Ridge horizon, real-time sky, weather, sun, moon, rainbows | P2-C/P2-D: scene and environment acceptance matrix |
| R13 | Suitable for an all-day dedicated monitor and open-source distribution | P1-E/P2-E/P3: soak tests and installation rehearsal |

“Every” is evaluated against the explicitly declared repository/ref scope below. Resource limits must produce a visible incomplete/loading state, never a silently incomplete graph presented as complete.

## 3. Decisions to carry into implementation

These are recommended defaults, not claims about existing code. Change them through a short architecture decision record (ADR) with evidence and update this roadmap.

| Topic | Baseline decision | Reason / reconsideration trigger |
| --- | --- | --- |
| Application shape | Local background process serving a browser UI on loopback | Git/filesystem access plus easy dedicated-monitor display; no desktop shell initially |
| Language | TypeScript across service, graph core, and UI | Shared contracts and one contributor toolchain |
| Runtime / tooling | Active Node.js LTS at implementation time, npm lockfile, Vite, React | Familiar small-project tooling; pin actual versions in P0 |
| Git integration | Installed Git CLI, invoked with argument arrays | Reuses user authentication and Git's object/ref semantics |
| Phase 1 drawing | SVG graph with HTML controls and details | Inspectable, accessible, easy hit testing at the initial supported size |
| Phase 2 drawing | Canvas 2D compositing plus HTML accessibility layer | Curved stems, sprite atlases, and economical rendering; evaluate WebGL only if measured need |
| Live UI transport | Server-sent events (SSE), versioned snapshots, ordinary HTTP reads | Updates flow primarily service-to-browser; simple reconnect recovery |
| Local change detection | Filesystem hints plus periodic reconciliation | Watchers alone can miss events or fail on some filesystems |
| Remote change detection | Scheduled fetch to app-owned bare caches | Works behind NAT and without GitHub admin permission |
| GitHub events | Optional authenticated receiver/relay after polling works | Desktop loopback is not directly reachable by GitHub |
| Persistence | Git object caches plus atomic JSON metadata initially | Avoid a database before there is a demonstrated need |
| Layout | Deterministic upward DAG, stable lanes, compressed old paths | Git history is a DAG, even when its visual metaphor is a tree |
| Platform | Windows-first development; Windows, macOS, Linux release checks | Match the initial workstation without embedding Windows-only assumptions |
| Weather | Optional provider interface; select provider in P2-D | Offline Git monitoring must not depend on a weather subscription |

Do not add a cloud platform, database service, desktop wrapper, or OAuth service solely to get the first graph running. A desktop package may later wrap the same service/UI boundary.

## 4. Exact Git and time semantics

### 4.1 Repository identity and ref scope

- A configured `id` is the persistent UI/cache identity. Renaming a label does not move its plot or erase camera preferences.
- A local source resolves the actual Git directory and common Git directory through Git, including linked worktrees and `.git` files. Do not assume `<path>/.git` is a directory.
- Paths sharing one common Git directory form one repository with multiple worktree markers. Duplicate config entries for that common directory are rejected with a useful diagnostic unless a future explicit duplicate-view feature exists.
- Two independent clones are separate repositories unless the user deliberately combines them in a future feature. Similar remote URLs alone are not sufficient to merge local state.
- A local source includes local `refs/heads/*`, cached `refs/remotes/*`, commit-pointing tags, and HEADs from discovered worktrees. Ignore symbolic aliases such as `origin/HEAD` as extra branches. Exclude stash, notes, pull-request refs, replacement refs, and reflogs by default.
- Remote tracking refs read from a user's clone describe its **last fetched** state. Label them accordingly. If remote monitoring is enabled for that source, the app-owned remote cache is authoritative for that remote's current branches/tags; avoid displaying both stale tracking refs and authoritative refs as two current versions of the same branch.
- A remote-only source includes all advertised branches and tags that the user's credentials can fetch, not just the default branch. Its worktree list is explicitly “not available for remote-only sources.”
- In a mixed local/remote plot, identify refs by `(source, remote name if any, full ref name)`. Preserve local and remote branches with the same short name; identical target commits share a node with several badges.
- Commits are identified by their full object IDs, without assuming a 40-character SHA-1 string. Display abbreviated IDs only when unambiguous within the repository.
- A branch is a ref label pointing at a commit, not a separate duplicate commit. A ref moving or disappearing changes its badge and potentially graph selection.
- An unborn branch gets an empty-repository placeholder and branch name, never a fabricated commit. Unrelated histories remain separate connected components inside the same plot; decorative ground is not a shared Git ancestor.
- “All commits” means commits reachable through parent links from the selected refs and worktree HEADs. Unreachable/dangling objects and commits existing only in expired/deleted refs are outside the live view. This is a current-state monitor, not an audit log.
- Shallow or partial repositories cannot prove complete ancestry. Display explicit boundary markers and completeness status. Never deepen or repair a user's clone automatically; an app-owned full cache can supply missing remote history. Explain missing unpushed local ancestry when it cannot be resolved.
- Read physical commit parentage, with replacement-object behavior disabled for graph reads; detect and flag legacy grafts or unsupported repository formats rather than silently drawing altered ancestry.

### 4.2 Business-day window

Baseline configuration: `businessDays = 2`, weekdays Monday–Friday, IANA time zone chosen explicitly or resolved from the system and shown in the UI. Use committer time for membership; show author time separately in details. This describes commit timestamps, not when a push arrived.

Define the window precisely:

1. Capture one `now` instant for the entire graph build and convert it to the configured time zone.
2. Starting with today's local calendar date, walk backward collecting dates whose weekday is configured as a business day, stopping after N dates. Today counts if it is a business day.
3. Set the lower bound to local midnight at the start of the oldest collected date. Select reachable commits with committer timestamps in `[lowerBound, now]`.
4. Include intervening nonbusiness dates. This is a continuous lookback window measured in business days, not a filter that hides weekend work.
5. On a nonbusiness day, count backward from the most recent business day and still include commits through the current moment.

Examples for N=2, Monday–Friday:

| Current local date | Window starts | Result |
| --- | --- | --- |
| Tuesday | Monday 00:00 | Monday and Tuesday so far |
| Monday | Friday 00:00 | Friday, weekend, Monday so far |
| Saturday or Sunday | Thursday 00:00 | Thursday, Friday, and weekend so far |
| Any date with N=1 and all seven weekdays enabled | Today 00:00 | Current calendar day so far |

Reject N<1, nonintegers, an empty weekday set, unknown weekdays, and invalid time zones. Holidays are a future extension, not silently inferred. Use calendar arithmetic across daylight-saving changes, not subtraction of N×24 hours. Recompute at local midnight, after sleep/resume, after clock/time-zone changes, on config changes, and during normal reconciliation. Future-dated commits still appear if they are required heads/anchors, with a timestamp warning; schedule later membership reevaluation.

Do not stop traversing ancestry when one commit has an old timestamp: dates need not be monotonic along parent edges. A full topology index filtered by timestamps is the correctness baseline. `--since-as-filter` can help a future optimized traversal, but a simple `--since` walk is not the selection specification. See [Git log options](https://git-scm.com/docs/git-log).

### 4.3 Common ancestors: explicit interpretation

Interpret “each common ancestor for each combination of branch heads” as **every best common ancestor (merge base) of every subset of two or more distinct branch-head commits**. Including every historical common ancestor would restore most of the full history and conflict with the short-tree goal. This interpretation is a documented design choice; keep it explicit in user documentation.

Git can have multiple equally good merge bases, particularly with criss-cross merges. Pairwise merge bases alone do not specify every multi-head subset. Also, ordinary `git merge-base A B C` does not mean the common ancestors of all three; `--octopus` is the relevant multi-head mode. Use `--all` when testing for multiple results. See [Git merge-base semantics](https://git-scm.com/docs/git-merge-base).

Specification:

- Let H be the distinct commit targets of in-scope branch refs. Deduplicate targets for analysis but retain every ref label.
- Let `Anc(h)` include h itself and all of its ancestors.
- For each subset S of H with size at least two, consider the intersection of `Anc(h)` for h in S.
- Keep its maximal elements under ancestry: a candidate is not best if a newer common descendant exists. The union over these subsets is the required ancestor set A.
- A head may also be a merge base; it remains one node with several reasons for inclusion. Disconnected subsets have no merge base and must not acquire a fictional connecting root.

Avoid production enumeration of all `2^|H|` subsets. Proposed exact DAG algorithm, to prove and benchmark at P1-B:

1. Build the reachable commit DAG with parent and child adjacency.
2. Assign each distinct head a bit. Traverse from children toward parents, propagating the bitset `D(v)` of heads descended from v, including v when it is a head.
3. Select v as an ancestor anchor exactly when `|D(v)| >= 2` and no immediate child c has `D(c) = D(v)`.
4. Justification: if a child has the same set, it dominates v for every subset v could serve. Otherwise v is itself a best common ancestor for subset `D(v)`. Any dominating descendant would require an immediate child carrying that entire set.
5. Validate independently against exhaustive subset intersections/maximality on small generated DAGs, with Git command fixtures as a second check. Do not assume the proof alone establishes a correct implementation.

The bitset propagation target is approximately O((V+E)×ceil(H/wordSize)) time and O(V×ceil(H/wordSize)) memory, plus adjacency. Large histories and thousands of heads can still be expensive. Start exact, cache topology, measure, and expose any resource limit. Do not replace the requirement with pairwise heuristics to pass a benchmark.

### 4.4 Visible nodes and honest compression

Construct the mandatory commit set M as the union of:

1. Every branch-head commit H.
2. Every required ancestor anchor A.
3. Every reachable commit in the business-day window R.
4. Every known worktree HEAD W, including detached HEADs.

Tags on selected commits appear immediately. To keep a repository with thousands of historical tags short, older tag-only targets are indexed and searchable in the repository details, but are not mandatory graph anchors by default. Selecting an old tag can temporarily reveal its commit and connecting context, marked as an inspection expansion. Tags that resolve to trees/blobs are listed as noncommit tags and do not become fake commit nodes. Annotated tags retain their own metadata and peeled target.

Build a reduced DAG by walking parentward from each selected node and connecting it to the first selected nodes reached along each path. Stop each path at those selected nodes. Deduplicate equivalent endpoint connections; record whether each edge is direct or represents hidden ancestry. No edge may imply ancestry that does not exist.

- A direct edge means an actual parent relationship. Preserve parent order in the underlying data, including octopus merges.
- A collapsed edge is visibly marked and exposes hidden-ancestry information on inspection. It does not claim a direct parent. For one linear path, give its exact hidden commit count. For multiple hidden paths, say “multiple paths” unless the UI explicitly labels an exact distinct-commit count; never imply a unique sequence.
- Small context nodes may be added to make recent forks/merges readable. Give each an inclusion reason and a bounded, documented expansion rule; do not restore all old junctions automatically.
- Missing-object/shallow boundaries use a different symbol from intentional history compression.
- Repositories with no recent commits show only their required skeleton, with compact vertical spacing and a “no recent commits” cue. Many surviving heads or complex required ancestors can still produce a large skeleton; fidelity wins over an arbitrary small height.
- Compress visual height according to retained topology, not elapsed years or number of hidden commits. Use topological height so clock-skewed child timestamps cannot invert an edge.
- Branch deletion, force-push, and pruning recompute M from current state. Removed unreachable commits may disappear. A brief transition is allowed; indefinite historical ghosts are not the default.

## 5. Service architecture and data contracts

Suggested source layout, to establish in P0 without filling it with speculative abstractions:

```text
src/
  core/           # Pure graph selection, time windows, contracts
  git/            # Subprocess adapter, ref/object/worktree readers, caches
  monitor/        # Scheduling, watcher hints, reconciliation, status
  server/         # Loopback HTTP, SSE, configuration lifecycle
  ui/             # Garden/focus state, details, accessibility
  render/         # Layout, technical SVG, later garden Canvas
  environment/    # Later weather and astronomy providers
tests/
  fixtures/       # Reproducible Git repository builders
  integration/    # Real Git and service tests
  e2e/            # Browser interactions and reconnects
docs/
  decisions/      # ADRs and benchmark evidence
  assets/         # Art direction, provenance, licensing
```

Data flow:

```text
config -> source adapters -> reconciler -> immutable repository snapshot
                              ^                        |
                 watcher / timer / webhook       graph selection
                                                       |
                                              deterministic layout
                                                       |
                                              SSE -> UI renderer

clock / weather provider -> environment snapshot -> scene renderer
```

Core contracts, independent of SVG, Canvas, React, and GitHub:

| Record | Minimum fields |
| --- | --- |
| Commit | repository ID, OID, ordered parent OIDs, subject, lazy full message, author/committer timestamps |
| Ref | stable source-qualified ID, full name, kind, target OID, peeled commit OID if applicable |
| Worktree | stable identifier, path, HEAD OID or unborn state, attached ref/detached, locked/prunable state |
| RepositorySnapshot | schema version, monotonic revision, captured time, refs, commits, worktrees, completeness, source statuses |
| VisibleGraph | snapshot revision, window bounds, nodes with inclusion reasons, edges with direct/collapsed/boundary type |
| Layout | graph revision, stable node positions, edge curves, bounds, render-independent hit targets |
| SourceStatus | initializing/ready/stale/offline/error/incomplete, last attempt, last success, sanitized diagnostic |
| EnvironmentSnapshot | observation/forecast time, fetch time, provider attribution, normalized weather, astronomy, stale status |

Keep local and remote freshness separate. A current local graph does not establish that the remote was checked successfully. Status indicators must distinguish “empty,” “no recent commits,” “initializing,” and “last known state.”

### 5.1 Safe and consistent Git reads

- Invoke Git directly without a shell, with explicit working directory, bounded output, cancellation, and timeouts. Separate paths/ref inputs from options; validate source URLs and reject unsupported transport/helper schemes.
- Prefer machine formats: ref enumeration, ordered parent OIDs, batch object reads, and `git worktree list --porcelain -z`. Parse length-framed object bodies correctly; do not assume commit messages are one line or invent an unsafe delimiter. See [Git worktree formats](https://git-scm.com/docs/git-worktree).
- Enumerate ref and worktree targets, read immutable objects by OID, then re-read target state. Retry a bounded number of times if targets changed; on sustained churn keep the last coherent snapshot and show updating. Never publish edges whose endpoint objects were only half read.
- A single app-owned Git object cache per configured repository can combine fetched remote objects with read-only local object lookup. Avoid object alternates as the default: local garbage collection can invalidate them. Do not persist copied private messages outside the necessary local cache without documenting retention.
- Run fetch only in app-owned bare storage. Explicitly fetch all configured branch/tag namespaces, including non-fast-forward updates and deletion reconciliation. Keep each remote's tags separate so identical tag names cannot collide. Test exact refspec and pruning behavior against supported Git versions; do not rely on defaults. See [Git fetch](https://git-scm.com/docs/git-fetch).
- Never enable a broad mirror/prune operation inside the user's clone. Keep cache cleanup constrained to known app-owned directories. Removing a source stops monitoring; separate explicit cache removal controls disk cleanup.
- Serialize writers per cache; globally bound network and Git process concurrency. Shutdown cancels child processes and releases locks. One failing repository cannot block the garden.
- Support users' existing SSH agents and credential helpers. A configured `gh auth setup-git` may enable HTTPS access, but merely being logged into `gh` does not guarantee every Git transport is configured. Provide actionable errors without changing credentials automatically.
- Background fetch must not hang on terminal prompts. Use noninteractive operation and an actionable authentication-needed state; document testing the same URL with Git in the user's terminal.
- Do not execute repository scripts or install hooks. Treat credentials/helpers configured by the user as part of their local trust boundary. Render ref names and messages as text, never executable HTML.

### 5.2 Update and reconnection protocol

P1 defaults: 250 ms local event debounce, 5 s local reconciliation, 60 s remote polling with approximately ±10% jitter, maximum two concurrent remote fetches, and a 120 s fetch timeout configurable for initial large transfers. Benchmark and adjust these defaults at P1-E.

- Watch relevant common Git metadata, per-worktree HEAD metadata, refs, and packed refs. Do not recursively watch source files merely to detect commits. Reinstall watches after atomic file/directory replacement.
- Treat watcher events as invalidation hints. Periodic reconciliation is mandatory because filesystem watching has platform caveats; see [Node filesystem watch documentation](https://nodejs.org/api/fs.html#caveats).
- Use one refresh in flight per repository; merge additional triggers into one pending refresh. Do not let older asynchronous results overwrite newer revisions.
- Back off failed network fetches exponentially with jitter to a proposed 15-minute cap. Show the next retry, keep local monitoring live, and allow manual retry. Honor provider retry/rate-limit guidance when using provider APIs.
- On sleep/resume or network recovery, stagger source refreshes and rebuild time membership. Reconcile even when refs are unchanged because the calendar window may have moved.
- Start with full versioned graph snapshots; introduce deltas only after profiling. An SSE event identifies repository ID and revision. A connecting/reconnecting client obtains current snapshots; a missed revision always has a full-resync path.
- Bound event queues for slow/disconnected clients, send a resync signal instead of retaining unbounded history, and close unused connections. A stale selection resolves by OID or shows “no longer in the current graph.”
- Validate config changes before applying them atomically. Retain the last valid configuration on parse errors. Removing a repo cancels jobs, unregisters watchers, and updates the UI without restarting unrelated repos.

### 5.3 GitHub push notifications

GitHub webhooks deliver HTTP requests to a reachable endpoint; they do not directly subscribe a desktop application behind NAT. Polling therefore satisfies the initial release, with an optional event mode following it. See [GitHub webhook overview](https://docs.github.com/en/webhooks/about-webhooks).

P1-F should demonstrate one documented self-hosted HTTPS receiver or user-managed tunnel/relay. Do not bundle a required public service or silently provision infrastructure. Decide between a per-repository webhook and a GitHub App after comparing permissions and setup effort. Users without administration/install permissions retain polling.

Receiver contract:

- Validate the signature over the raw request body using a secret stored outside committed configuration, compare safely, bound payload size, and allowlist repositories/events. See [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- Acknowledge promptly after queuing a bounded invalidation; deduplicate delivery IDs for a bounded period. Treat duplicates, reordering, and missed deliveries as normal. See [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
- Subscribe to relevant push and ref create/delete events. A merged pull request changes Git refs and is discovered by fetch; pull-request events can be an extra hint but are not the graph authority. Cover tag changes as well as branches.
- Payload commit lists can be bounded or events unavailable for some bulk actions. Always fetch/reconcile rather than building the DAG from notification payloads. See [GitHub event payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push).
- A relay forwards minimal invalidations over an authenticated outbound desktop connection; do not forward private code or full messages. A direct tunnel exposes only the isolated receiver route, never the UI or Git command interface.
- Continue a configurable safety poll, proposed every 5 minutes in healthy webhook mode. Fall back to ordinary polling after receiver failure. Explain that missed intermediate force-pushed history cannot be reconstructed by this current-state monitor.
- Separately report last event received and last successful fetch. A valid event alone does not prove the graph is current.

## 6. Configuration contract

Use a versioned JSON file for the initial implementation: portable, strict, schema-validatable, and free of YAML type surprises. Supply `git-garden.example.json` and a JSON Schema in P1-A. The following is a design example, not a currently runnable configuration:

```json
{
  "version": 1,
  "server": { "host": "127.0.0.1", "port": 4783 },
  "history": {
    "businessDays": 2,
    "weekdays": ["mon", "tue", "wed", "thu", "fri"],
    "timeZone": "America/New_York"
  },
  "monitor": {
    "localReconcileSeconds": 5,
    "remotePollSeconds": 60,
    "maxConcurrentFetches": 2
  },
  "display": { "renderer": "technical", "reducedMotion": false },
  "repositories": [
    {
      "id": "git-garden-local",
      "label": "git-garden",
      "path": "C:/Users/me/projects/git-garden",
      "remotes": ["origin"]
    },
    {
      "id": "another-project",
      "label": "Another project",
      "url": "https://github.com/OWNER/REPOSITORY.git"
    }
  ],
  "environment": { "enabled": false }
}
```

Rules:

- Each repository has a unique ID and exactly one of `path` or `url`. `remotes` applies only to local sources and names existing configured remotes; omitted/empty means local-only, including visibly cached tracking refs.
- Resolve relative paths relative to the config file, not process working directory. Do not expand arbitrary shell expressions. Support spaces, Unicode, Windows drive paths, and documented UNC limitations.
- All branches are included by default. Any future branch filters must visibly declare reduced scope and must not silently become the default.
- Validate unknown keys as errors with a JSON location and helpful message. Validate numeric ranges, timezone, URL transport, duplicate source identity, and unsupported schema version.
- Define CLI precedence: explicit `--config` path, then documented per-user config location. Do not auto-load an arbitrary repository's config as trusted executable instructions. Provide `init-config` and `validate-config` commands in P1-A.
- Zero configured repositories is a welcome/setup screen, not a crash. Missing paths or unavailable remotes get isolated source errors while valid repositories render.
- Keep credentials, webhook secrets, and future weather API keys in environment variables or operating-system secret storage; config stores only references. Redact credential-bearing URLs in logs and reject inline URL passwords in config.
- Store caches under an OS-appropriate per-user application data/cache directory, outside monitored workspaces. Document size reporting and cleanup. Apply schema migrations explicitly and preserve a backup when writing configuration.
- Later environment settings add explicit latitude/longitude, time zone, weather provider, units, update interval, quality preset, and optional secret reference. No automatic location lookup by default. Provider requests disclose the configured location to that provider; explain this in setup.

## 7. Interaction and layout contract

### Garden and focused views

- Garden view (the all-repositories overview, as opposed to focus view) presents every configured repository in a deterministic order. Use an adaptive grid of plots initially; evolve it into a continuous hill while preserving stable plot identities.
- Where names and status appear depends on the renderer, by maintainer decision (2026-09-27). This is intended behavior, not an accessibility defect; do not "fix" it by adding always-visible text to the garden renderer:
  - The **technical renderer** shows each plot's name and compact source status at all times.
  - The **garden (botanical) renderer** is a natural scene first. Without pointer or keyboard interaction it shows no names, status lines, or placeholder text. Names, status, and empty/error explanations appear on hover, keyboard focus, or tap, and the accessible names and status text stay in the DOM for assistive technology.
  - The garden renderer must still surface health without text, so a broken or empty repository is never an invisible plot: a repository with nothing to draw is a bare soil bed; an unhealthy source (error, offline, loading, stale, incomplete) or an unreachable monitored remote carries a small garden marker stake with its state glyph; a last-known (stale or incomplete) plant is desaturated like a wilting one. New cues must stay quiet, in-world, and not rely on color alone.
- **Garden-renderer hillside** (maintainer decision, 2026-09-27; see [ADR 0015](docs/decisions/0015-botanical-renderer-proof.md)). Dense, overlapping planting is intended, not a defect: focus view is how a user isolates one plant.
  - Up to 64 repositories grow on the hillside; more use the card layout. There are 64 fixed, pre-set bush positions (`src/ui/hillside.ts`), perspective-mapped rows on the backdrop's grass, each growing from the ground. It is a fixed table, not a computed layout. However many repositories are configured are spread evenly over those 64 positions, in configuration order, back to front and left to right.
  - Each position has its own fixed, pre-set focus-icon position. At 1920×1080 and larger no two 44×44 icons overlap, and icons sit above every plant, so every icon is always reachable by design.
  - Icons are hidden until hovered: hovering an icon or its plant, or keyboard focus on either, reveals that plant's icon and its name/status card. The same hover outlines that plant, and only that plant, in cyan, so it is unambiguous what a click will focus.
  - Clicking or tapping the icon or any part of the plant focuses that repository. On the hillside a plant is one target: commit tooltips and pinned details belong to focus view (and the technical overview).
- In the technical renderer: on pointer entry into a plot or keyboard focus within it, reveal a circular `+` centered above the tree's bounds with a minimum 44×44 CSS-pixel hit target. Keep it visible while traversing from tree to button; reserve layout space to avoid clipping.
- Clicking `+` focuses exactly that repository. Replace it with a circular `-` in the same conceptual position. Clicking `-` or pressing Escape restores the previous garden camera, scroll position, and focused plot.
- Hovering a commit/ref/tag/worktree gives a brief tooltip (in focus view and the technical overview). Clicking/tapping pins a details panel with full message, OID, timestamps, all attached refs/tags, and worktree information. Clicking a commit must not unexpectedly zoom the whole tree.
- Focus view supports fit-to-tree and bounded pan/zoom. Garden view fits a useful number of plots, with scroll/pan for larger configurations. Never shrink every label below readability merely to fit unlimited repositories on one screen.
- In focus view, live updates retain the selected commit and avoid camera jumps. Fit again on explicit request; new off-screen content gets a subtle indication. Deleting the focused configuration returns to the garden.
- Touch users have persistent focus controls (on the garden hillside, the plant itself is the control). Keyboard users can select a plot, activate `+`/`-`, navigate nodes through an accessible list, and open/close details. Accessible labels say “Focus <repository>” and “Show all repositories.”
- Status, selection, branch type, and edge type cannot rely on color alone. Honor OS reduced-motion preference even if the config does not request it; explicit application controls may only reduce motion further.

### Graph layout

- Parents below children; roots near ground. Topology determines ordering, with timestamps only as stable tie-breakers where safe. Show oldest-to-newest direction in the legend.
- Use persistent lane preferences keyed to refs/commits; minimize movement of unchanged nodes after a small update. Deterministic OID/ref tie-breakers prevent random rerenders.
- Multiple labels on one commit fan out or collect into an expandable badge. All names remain accessible in details. Crossings are distinguishable from actual merge junctions.
- Distinguish local/remote head markers, tags, worktrees, collapsed ancestry, and missing history. Worktrees use attached markers, not extra Git edges.
- Layout is calculated off the browser's critical interaction path when necessary. Cache by graph revision and relevant viewport settings; keep scene animation separate from graph recomputation.
- Start with deterministic layered lanes; compare a layout library only against real fixture failures. A generic tree layout cannot represent merges accurately.
- All mandatory nodes remain in the semantic model. Culling off-screen artwork is allowed; silently sampling away recent commits or heads is not. Large scenes need navigation, explicit loading, and a complete accessible list.

## 8. Phase 0 — Foundation and executable specifications

Dependencies: none. Outcome: reproducible contributor environment and small Git fixtures that make the ambiguous requirements testable.

### P0-A: Project foundation

- [x] Record ADRs for local browser architecture, read-only source policy, exact ancestor interpretation, time-window semantics, and initial rendering stack.
- [x] Pin supported Node/Git versions after capability checks; establish TypeScript strict mode, formatting, lint, build, unit-test, and browser-test commands. *(Browser tests: `npm run test:e2e`, ADR 0011.)*
- [x] Add README contributor setup, `.gitignore`, lockfile, config/cache exclusions, and minimal CI for Windows, macOS, Linux.
- [x] Preserve MIT licensing; add contribution and security-reporting guidance without suggesting affiliation with an employer or animation studio.
- [x] Add deterministic demo fixtures, with fictional names/messages and no private repository metadata.

Exit: a fresh clone can install, build, and run one meaningful test on each CI OS. README identifies implemented versus planned features. No empty framework or success-only test counts as validation.

### P0-B: Risk probes

- [x] Demonstrate machine-readable refs, annotated tags, detached/unborn worktrees, and ordered parents using installed Git.
- [x] Build fixtures for a fork/merge, old branch heads, three-head ancestry, and a criss-cross merge with multiple bases.
- [x] Prototype the bitset ancestor selector and an independent exhaustive oracle; record correctness and memory/time observations.
- [x] Prove app-owned fetch sees a remote update without changing user refs, index, working files, or Git configuration.
- [x] Show one static upward SVG DAG with merged edges and a collapsed old path.

Exit: write evidence in `docs/decisions/`; resolve any algorithm contradiction before product UI development. Risk probes are allowed to be small throwaway scripts, but the fixtures should become reusable tests.

## 9. Phase 1 — Reliable real-time gitk-style visualization

The Phase 1 release is independently useful. No art, weather, relay hosting, or desktop packaging is required to use it.

### P1-A: Local source and configuration

Dependencies: P0. Suggested working increment: one local repository rendered as a debug snapshot.

- [x] Implement versioned config validation, documented defaults, example file, and `init-config`/`validate-config` commands.
- [x] Implement safe Git subprocess wrapper with cancellation, output limits, sanitized errors, and capability detection.
- [x] Resolve local/common Git directories and enumerate branch refs, tags, worktrees, and immutable commit objects.
- [x] Establish snapshot/status contracts and one loopback-only service endpoint.
- [x] Handle zero sources, empty repositories, missing paths, malformed config, Unicode paths, and paths containing spaces.

Exit: fixtures match Git's refs/parents/worktrees, invalid configs identify the failing field, and monitoring reads leave the fixture's user-owned Git state unchanged.

### P1-B: Exact graph selection and compression

Dependencies: P1-A; use a pure core with no browser or network requirements.

- [x] Implement business-day calculation using an injectable clock/time-zone boundary.
- [x] Implement reachable DAG indexing, exact head-subset merge-base union, mandatory node selection, and reduced edges.
- [x] Attach inclusion reasons and completeness metadata; implement old-tag lookup/temporary expansion.
- [x] Test timestamp inversion, DST, weekends, custom weekdays, old heads, duplicate heads, disconnected histories, criss-cross, octopus merges, and shallow boundaries.
- [x] Prove reduced edges preserve selected-node reachability in generated small DAGs; verify all mandatory nodes are retained.
- [x] Benchmark a long old history with very few selected nodes; show that rendering stays compact even if initial indexing is expensive.

Exit: independent oracle agrees for generated small cases, all required nodes are present, no false ancestry appears, and the exact quiet-repository behavior is documented with screenshots/fixture outputs.

### P1-C: Interactive technical renderer

Dependencies: P1-B. Suggested release label: local preview.

- [x] Implement upward layout, distinct edge types, repository plots, legends, and source status.
- [x] Add tooltip and pinned details for commits, all head names, tags, and worktree markers.
- [x] Implement circular `+`/`-`, hover continuity, focus transitions, camera restoration, Escape, touch, and keyboard equivalents.
- [x] Keep selection stable during updates; handle disappearing nodes and removed repositories gracefully.
- [x] Add empty/incomplete/stale states and an accessible semantic graph list.

Exit: browser tests reproduce every interaction in Section 7, multiple badges remain discoverable, and a person can explain the displayed fork and merge by inspecting actual parent relationships.

### P1-D: Continuous local and remote monitoring

Dependencies: P1-C; this is the first complete functional vertical slice.

- [x] Add watchers, debounced scheduling, periodic reconciliation, and business-window rollover without ref changes.
- [x] Add remote-only sources and optional remote monitoring for local plots through app-owned bare caches.
- [x] Implement full ref reconciliation, tag movement/deletion, force pushes, stale/error states, per-repo isolation, and bounded retry/concurrency.
- [x] Connect versioned snapshots to UI through SSE, including disconnect/reconnect and stale-response prevention.
- [x] Support config reload and clean source removal. Restart from last known cache with honest freshness and a new verification pass.
- [ ] Test with a local bare remote for automation, then manually rehearse a public and a private GitHub repo using user-managed credentials. *(Automated and public rehearsal done; private rehearsal is for the maintainer, steps in ADR 0012.)*

Exit: a live two-repository demonstration covers local commit, branch create/delete, merge, tag create/delete, worktree add/remove, remote push, remote deletion/force-push, offline mode, reconnect, and midnight window expiry. Each source recovers independently without page reload. No user repository mutations occur.

### P1-E: Hardening and usable release

Dependencies: P1-D. Suggested release label: `v0.1.0`, functional preview.

- [x] Run the correctness, performance, and security checks in Sections 12–13.
- [x] Publish installation/start/stop instructions, authentication troubleshooting, config reference, supported-size statement, and known limitations.
- [x] Provide a deterministic demo mode so contributors can view the product without credentials or a live repository.
- [ ] Run an eight-hour monitor session, sleep/resume test, and clean-install rehearsal on all supported operating systems. *(Clean-install rehearsal runs in CI on all three OSes; the 8-hour soak passed locally, see ADR 0013; physical sleep/resume is for the maintainer.)*
- [x] Measure remote cache size and expose diagnostics: source freshness, fetch failures, graph counts, build duration, and cache usage.

Exit: R01–R10 pass through the polling path, documented latency targets are measured, and a new user can configure and observe a repository without contributor assistance. This is the gate before production garden artwork.

### P1-F: Optional GitHub event acceleration

Dependencies: P1-D. Can follow P1-E or proceed alongside later art work; it must not delay the usable polling release.

- [x] Record receiver/relay topology, deployment instructions, permissions, operating costs, and secret rotation procedure.
- [x] Implement signed invalidations, repository allowlist, delivery deduplication, bounded queue, authenticated relay if used, and fallback polling. *(No relay: per-repository webhook to a loopback receiver behind the user's tunnel, ADR 0014.)*
- [x] Test forged payloads, oversized bodies, duplicate/out-of-order events, relay downtime, missed delivery, and reconnect.
- [ ] Rehearse branch pushes, merges, tags, branch deletion, and force-push end to end. *(Automated with signed local deliveries; a real GitHub-to-tunnel rehearsal is for the maintainer.)*

Exit: a documented opt-in setup improves update latency, a broken receiver cannot freeze the graph, and no publicly reachable UI or arbitrary-command endpoint exists. Retain a clear statement that polling is the supported default when webhook setup is impractical.

## 10. Phase 2 — The living garden

Dependencies: Phase 1 functional release. The technical renderer remains supported and is the visual-truth reference.

### P2-A: Art direction and renderer proof

- [x] Produce an original style sheet: shapes, materials, palette, lighting, scale, flower families, leaf pairs, fruit, grass, ridge silhouettes, and sky gradients.
- [ ] Design day, dawn/dusk, and night examples at 1080p and 4K. Target dimensional, softly lit, lightly stylized realism rather than flat icons or exact imitation of existing characters/scenes. *(Partial: CSS color-grade studies of one daytime backdrop; the 4K study is upscaled and night needs real art, ADR 0015.)*
- [x] Build one representative scene containing a fork, merge, tag, several coincident heads, and worktree markers.
- [x] Test Canvas 2D against SVG on identical geometry and a sprite atlas. Adopt WebGL only with a measured bottleneck and an ADR.
- [x] Define asset manifest fields: author/source, license, attribution, generation/editing provenance where applicable, dimensions, anchor points, scale variants, and redistribution rights. *(Fields defined; whether generated artwork can ship, and under what terms, awaits the maintainer.)*

Evidence: [art direction and exact prompts](docs/art/README.md), [asset manifest](src/ui/public/asset-manifest.json), shared Canvas/SVG proof and browser scenario matrix in `tests/e2e/botanical.spec.ts`, and [ADR 0015](docs/decisions/0015-botanical-renderer-proof.md). Day/dawn/dusk/night examples are static color-grade studies at 1080p and 4K viewports; the backdrop is upscaled, not native 4K. The full P2-A exit remains open pending maintainer review and baseline hardware/resource validation.

Exit: maintainer visual review accepts the direction, graph fidelity is intact, assets can legally ship, and the prototype meets the baseline rendering budget. Avoid producing a full asset library before this checkpoint.

### P2-B: Botanical graph renderer

| Git meaning | Garden expression | Fidelity rule |
| --- | --- | --- |
| Commit | Subtle stem knot and paired plant leaves | Same OID, hit target, and details as technical node |
| Parent connection | Curved tapered stem | Only follows real or explicitly collapsed ancestry |
| Fork | Stem divides, outgoing stems thinner | A crossing alone is not a fork |
| Merge | Stems join into a unified stem | Preserve all incoming parent connections |
| Branch head | Flower, with stable ref identity/color cues | Several refs at one node form a discoverable cluster |
| Tag | Fruit attached at its commit | Several tags remain individually inspectable |
| Worktree | Small marker near its HEAD/flower | Never imply a new commit or branch |
| Hidden history | Subtle segmented/marked stem section | Inspection explains compression |
| Unknown history | Distinct boundary treatment | Cannot be confused with a normal rooted plant |

- [ ] Render stems procedurally as curves/meshes; composite pre-rendered flowers, leaves, fruit, and grounding/shadow sprites.
- [ ] Define taper as a bounded visual rule: generally thicker lower down, split child widths reduced, merged width increased relative to its incoming continuations. Combine branch-flow and height terms with clamps; do not let a large merge become an unreadable trunk.
- [ ] Handle convergence and crossings with consistent depth cues. Garden rendering may adjust curves but may not change edge endpoints or graph reachability.
- [ ] Give stable seeds to asset variants so flowers do not change on every refresh. A moved branch head carries its ref identity to its new flower position.
- [ ] Animate new growth and ref movement briefly; use gentle crossfades for removed history. Honor reduced motion and retain exact hit targets while artwork sways.
- [ ] Share layout, graph selection, details, zoom behavior, and accessibility model across renderers. Provide an immediate technical-view switch for comparison.

Exit: the complete graph fixture suite can be inspected in both renderers with identical semantic results. No flower/fruit overlaps make a required ref inaccessible.

### P2-C: Hill and Blue Ridge setting

- [ ] Compose layered sky, distant mountain silhouettes with atmospheric perspective, manicured grassy hill, plot shadows, and foreground accents.
- [ ] Use original or appropriately licensed Blue Ridge reference imagery to guide recognizable ridge layering without depending on a live map service.
- [ ] Place each bush in a stable plot; accommodate disconnected components without creating a fake common stem.
- [ ] Design empty plots and inactive repositories as quiet, compact plants without presenting decorative elements as commits.
- [ ] Adapt to portrait, ultrawide, multiple plot counts, window resizing, and device pixel ratios. Preserve margins around `+`/`-` and inspection panels.
- [ ] Add restrained wind response with stable hit regions; avoid motion behind text and suspend decorative animation when hidden.

Exit: garden/focus transitions look coherent at 1080p and 4K, labels remain legible against all backdrops, and the setting feels complete even with weather disabled.

### P2-D: Time, weather, sun, moon, and rainbows

- [ ] Add an environment provider independent of repository refresh. Use explicitly configured coordinates and time zone, plus an injectable clock for tests.
- [ ] Select an astronomical calculation library by license, numerical tests, maintenance, and offline capability. Verify sun altitude/azimuth, sunrise/sunset, moon altitude, illuminated fraction, and waxing/waning against trusted published reference cases.
- [ ] Normalize screen east to the left and west to the right so the scene can show both sunrise and sunset. Document that this is a stylized panoramic sky, not the literal view from the monitor's orientation.
- [ ] Keep physical altitude and day/night transitions correct while projecting horizontal position for the composition. Handle polar day/night, below-horizon bodies, daylight-saving changes, and moon visibility during daylight.
- [ ] Render moon phase and limb orientation consistently; do not infer its altitude from its phase. Show stars and graded twilight without implying the moon only appears at night.
- [ ] Evaluate a weather provider, with Open-Meteo as one candidate, against licensing, attribution, commercial-use terms, quotas, geographic coverage, freshness, and offline behavior at implementation time. Do not equate an open-source client with unrestricted hosted-service use. See [Open-Meteo API documentation](https://open-meteo.com/en/docs).
- [ ] Normalize cloud cover, precipitation type/intensity, wind, temperature, and condition codes. Distinguish reported/modelled conditions from actual local observations; show source and valid time in environment details.
- [ ] Fetch weather at a provider-appropriate interval, initially proposed 15 minutes, with caching/backoff. Continue offline astronomy; show stale weather explicitly and transition to a neutral fallback after a documented expiry.
- [ ] Implement bounded cloud, rain, snow, and wind effects through quality presets. Cap particles; keep graph controls unobscured and avoid flashing lightning by default.
- [ ] Render occasional rainbows only as a plausible artistic inference when rain/showers and available sunlight support it, positioned opposite the sun in the stylized sky. Do not label a rainbow as an observed local fact unless the provider actually supplies that observation.
- [ ] Add developer-only deterministic overrides for sunrise, sunset, night, moon phases, cloud, rain, snow, high wind, and rainbow cases. Keep preview overrides visibly distinct from live conditions.

Exit: a recorded scenario matrix covers the above conditions, high latitudes, stale/offline data, and clock jumps. Git monitoring and UI interaction remain responsive when every environment request fails.

### P2-E: Ambient quality and visual release

- [ ] Tune original art, transitions, light/shadow, day/night contrast, legibility, and motion with the maintainer on the intended dedicated monitor.
- [ ] Ship low/balanced/high quality presets, reduced motion, rendering pause when hidden, and a static low-power mode.
- [ ] Run a 24-hour mixed-weather soak including many repository updates, focus changes, disconnects, and sleep/resume.
- [ ] Review all asset licenses/attributions, environment-provider requirements, and accessibility behavior before distribution.
- [ ] Publish a short demo and screenshots from fictional/public fixtures, plus an explanation of how every garden element maps to Git.

Exit: R11–R13 pass, the garden is attractive in both active and quiet states, and the scene meets measured monitor-resource budgets. Suggested release label: `v0.2.0` or a garden beta, not an automatic stability promise.

## 11. Phase 3 — Sustainable public release

- [ ] Rehearse installation with a user who did not build the project. Improve errors and setup instructions based on that rehearsal.
- [ ] Decide distribution format from evidence: npm/CLI first, optional desktop wrapper later if startup and auto-launch friction justify it.
- [ ] Document dedicated-monitor startup, fullscreen controls, supported browsers/platforms, data locations, uninstall/cache removal, upgrades, and rollback.
- [ ] Add changelog/release process, compatibility policy, schema migration tests, dependency/license checks, and public issue templates.
- [ ] Document contribution areas for graph logic, platform support, accessibility, artwork, translations, and environment providers.
- [ ] Define bug reporting with opt-in sanitized diagnostics; exclude messages, private paths, tokens, and remote URLs by default.
- [ ] Complete public/private GitHub and local-only installation checks on supported OSes. Keep a provider-free offline demo working.
- [ ] Decide whether optional desktop releases justify signing/notarization costs; document unsigned-package limitations honestly if applicable.

Exit: a versioned stable release has reproducible build instructions, redistributable assets, no required central service, and a maintainer-manageable support surface. Keep feature expansion separate from stabilizing this release.

## 12. Verification strategy and performance targets

### Correctness fixtures

Build temporary repositories with deterministic timestamps and explicit commits/parents; do not rely on whatever history the developer happens to have checked out. Use an injectable clock. Integration tests use a temporary local bare remote so normal CI needs no GitHub credentials.

| Fixture / event | Required assertion |
| --- | --- |
| Empty/unborn repository | No fabricated OID; useful placeholder |
| Linear history with years of old commits | All recent commits retained, old head retained, compact older path |
| Old divergent branch and ancestor | Old head and required base survive cutoff |
| Two refs on one OID | One node, both names inspectable |
| Head ancestral to another head | Ancestral head retained and may be its own base |
| Three or more heads | Every subset's best bases match independent oracle |
| Criss-cross merges | Multiple best bases retained |
| Octopus merge | All parents represented honestly |
| Unrelated histories | Separate components; no invented ancestry |
| Old parent with recent ancestor timestamp | Recent ancestor still included despite timestamp inversion |
| Monday/weekend/custom weekdays/DST | Exact local-calendar window membership |
| Window changes without new commits | Expired optional nodes disappear on schedule |
| Annotated/lightweight/moved/deleted/noncommit tags | Correct target, metadata, and display policy |
| Attached/detached/locked/prunable worktrees | Correct markers and lifecycle without modifying worktrees |
| Linked worktree config path | Correct common-directory identity |
| SHA-256 repository where supported | No fixed SHA-1 assumptions |
| Shallow/missing-object history | Visible incomplete boundary, never false completeness |
| Force push / branch delete | Stale heads disappear after successful reconciliation |
| Authentication/network failure | Last-known data and clear freshness; other plots continue |
| Rapid mutation during reading | Coherent snapshot or explicit updating status |
| Watcher misses an event | Periodic reconciliation still discovers it |
| SSE disconnect / slow client | Bounded memory, full resync, no stale revision overwrite |
| Invalid/changed config | Last valid state retained; valid changes apply atomically |
| Untrusted message/ref text | Text displayed without executing markup |
| Garden versus technical renderer | Same semantic nodes, refs, tags, and selection |

Property tests should verify mandatory-set inclusion, ancestor-selection equivalence, acyclicity, reduced reachability, and deterministic layout. Avoid tests that merely duplicate implementation steps. Snapshot images supplement structural assertions; they do not prove graph correctness.

### Initial performance envelope

These are engineering targets to measure at P1-E, not promises about unbuilt code. Record CPU model, memory, operating system, browser, Git/runtime versions, repository shape, and viewport in the benchmark report. Use a proposed baseline of a four-core laptop, 16 GB RAM, integrated graphics, and a 1080p display; measure 4K separately.

| Metric | Initial target / measurement condition |
| --- | --- |
| Supported ordinary workload | 10 configured repos, 100 branch-head targets and 100k reachable commits per repo, up to 2,000 selected nodes total |
| Local detection to visible update | p95 <=2 s with working watchers; <=7 s through 5 s reconciliation on a small warm repo |
| Remote polling latency | <=configured interval + jitter + measured fetch/build time, when healthy; expose these components |
| Webhook latency | p95 <=5 s after validated receipt through fetch/render on small warm repos; exclude provider delivery delay |
| Warm garden startup | First cached view <=2 s; freshness validation follows asynchronously |
| Cold indexing | Progressive status within 1 s; target <=30 s for one local 100k-commit/100-head fixture on baseline hardware; report network clone separately |
| Typical incremental graph build | p95 <=500 ms for the documented benchmark after indexing; move expensive work off UI path |
| Interaction | Input response <=100 ms; >=30 fps during pan/zoom on baseline workload |
| Idle technical view | Event-driven drawing; service+UI average <2% total machine CPU over a quiet 5-minute sample |
| Balanced garden | Target <10% total machine CPU and 30 fps only while visibly animating; record GPU use and offer lower-power mode |
| Memory | Target <500 MB combined service and browser workload at baseline, excluding shared browser overhead where measurable |
| Long-running stability | No unbounded listeners, event queues, cached snapshots, process count, or sustained memory growth during soak |

Also stress one million commits, 1,000 heads, and 10,000 selected nodes. The stress gate is graceful progress, cancellation, bounded queues, and honest incomplete status, not the ordinary latency target. Never drop mandatory nodes silently to meet a budget. If the exact algorithm exceeds limits, retain the last valid snapshot, explain the limit, and let the user reduce explicitly declared scope or allocate more resources.

Measure indexing, selection, layout, serialization, and drawing separately. Optimize the measured bottleneck. Re-run relevant benchmarks after graph-algorithm or renderer changes rather than expanding the stack preemptively.

## 13. Operational, privacy, and security constraints

- Bind to loopback by default and initially reject nonloopback hosting configuration. Serving a private graph over a LAN is a separate authenticated-hosting feature.
- Validate Host/Origin for local API access, use a per-run session capability for sensitive routes, avoid permissive CORS, and protect any mutating/config/refresh endpoints from cross-site requests. A browser on an unrelated website must not be able to read private commit data or initiate arbitrary Git commands.
- The public webhook adapter is isolated from the local API. No request body may choose a filesystem path, Git command, executable, or arbitrary fetch URL.
- Show remote links only when derived safely from known hosts and open them with safe browser attributes. Escape all repository text and constrain content security policy.
- No source-tree mutations, automatic hooks, global Git configuration changes, or automatic credential changes. Verify this with before/after tests on monitored fixtures.
- Treat cached commit metadata and bare objects as private repository data. Store in per-user locations with appropriate permissions; document retention and explicit cleanup. Do not claim encryption at rest unless it is implemented.
- Redact secrets, authenticated URLs, and private paths in default logs. Rich diagnostics must be explicit and locally stored. No telemetry by default.
- Bound network responses, subprocess runtime/output, config file size, webhook queues, and image/asset loads. Errors are per-source and should not terminate the service.
- On port conflict, print a clear diagnostic and an explicit alternate-port option. On shutdown, close SSE clients, cancel fetches, and atomically persist only coherent metadata.
- Keep GitHub API/notification integration optional; Git transport polling works for other compatible hosts. Avoid provider-specific fields in the core DAG.

## 14. Decision register and known risks

| Decision / risk | Baseline resolution | Revisit at |
| --- | --- | --- |
| Meaning of “each common ancestor” | Best bases for all head subsets; full ancestry remains inspectable through expansion | P0, before selector implementation |
| Weekend semantics | Continuous window spanning N selected business dates through now | P0; document examples prominently |
| Large histories / many heads | Exact indexed traversal and bitsets, explicit limits, measured optimization | P0-B and P1-E |
| Full remote history download | App-owned bare cache; initial transfer can be substantial | P1-D; consider object filtering only after completeness proof |
| Watcher portability | Hints plus periodic reconciliation | P1-D on all OSes |
| Local clone and remote disagreement | Source-qualified refs and separate freshness | P1-D |
| Private GitHub access | User's existing Git credentials; no mandatory application OAuth | P1-D manual rehearsal |
| Old tags inflate graph | Index all; decorate selected commits, expand older targets on inspection | P1-B/P1-C |
| Webhook reachability/permissions | Optional receiver/relay, always retain polling | P1-F |
| Dense graph readability | Stable layout, focus/navigation, semantic list, honest edge compression | P1-C/P2-B |
| Artistic stem widths imply false history | Width is decorative; connectivity and inspection remain authoritative | P2-B |
| Asset cost and redistribution | Small original atlas, provenance manifest, license audit | P2-A/P2-E |
| Weather service terms and outages | Provider interface, offline astronomy, cached/neutral fallback | P2-D |
| Geographic sky versus composition | Physical altitude/phase with documented panoramic east/west projection | P2-D |
| Desktop installation friction | CLI/browser first; wrapper only after user rehearsal | P3 |

Open choices intentionally deferred: exact dependency versions, layout-library adoption, astronomy library, weather provider, webhook hosting provider, desktop wrapper, flower species/palette, and holiday calendars. Each has a milestone owner/gate above; none should block the first local functional slice.

## 15. Working agreement for future implementation sessions

1. Read this roadmap and the current repository instructions, inspect the working tree, and identify the earliest incomplete dependency gate. Do not assume checked-in plans imply implemented code.
2. Pick a small vertical increment with a demonstrable outcome. For the first coding session, complete P0-A and begin P0-B; do not start weather, cloud hosting, or a production art library.
3. Before changing a contract, record the decision and update examples, schema, tests, and this roadmap together. Explicitly identify changes to user-visible requirements.
4. Use fictional/local fixtures for ordinary tests. Do not require private repositories, company resources, production webhook secrets, or paid accounts for CI.
5. Implement and run checks appropriate to the increment. Retain outputs or benchmark summaries that establish checkpoint completion; avoid claiming a whole milestone complete from one happy-path demo.
6. Update the relevant checkbox only when its deliverable exists and its verification passes. Record milestone completion evidence in the table below, linking files/tests/PRs or releases.
7. End each implementation session with what changed, checks run, known limitations, and the next concrete unfinished task. Preserve working user changes and the project's independent open-source ownership.

### Completion ledger

| Gate | Status | Evidence / next step |
| --- | --- | --- |
| Design baseline | Documented | This roadmap |
| P0 foundation and risk probes | Done | P0-A: ADRs 0001–0006 in `docs/decisions/`; `npm run check` passes locally on Windows and in CI run 36222369361 on Ubuntu, Windows, and macOS (26 tests each, Git 2.55; golden fixture OID matched everywhere); fixture topology verified against `git merge-base` in `tests/fixtures/builder.test.ts`. Open: browser-test command (deferred to first UI). P0-B: ancestor selector matches an exhaustive oracle (2,000 random DAGs) and `git merge-base` (demo fixtures and 12 random repositories), green in CI run 36244010015 on all three OSes (43 tests each); deliberate bugs are caught; stress case (1M commits, 1,000 heads) takes about 3.5 s and 650 MiB on a 4 GB Core m3 ([ADR 0007](docs/decisions/0007-ancestor-selector-evidence.md)). Git readers (refs, peeled tags, worktrees, topology, length-framed commits) verified against fixture truth and independent Git commands; app-owned cache fetch leaves the user's clone byte-identical ([ADR 0008](docs/decisions/0008-git-read-and-fetch-evidence.md)). Static SVG of `gardenTour` through the full read-only pipeline, with reduced edges and layout checked by independent oracles ([ADR 0009](docs/decisions/0009-visible-graph-and-static-svg.md)). P0-B complete. |
| P1 functional visualization | Done (maintainer rehearsals open) | P1-A done: strict config with line/column errors, validated against the JSON Schema via Ajv; `init-config`/`validate-config`/`serve`; loopback server with Host/Origin checks and a local SVG preview; isolated per-source status. P1-B core landed early for the SVG probe. P1-B done: every checklist item has an oracle-checked test or measurement; quiet repositories keep a compact skeleton (100k-commit history renders 7 commits in 300 px; cold read and selection about 3.3 s) ([ADR 0010](docs/decisions/0010-quiet-history-and-pipeline-benchmark.md)). P1-C done: React UI with the section 7 interaction contract, verified by 10 Playwright browser tests on real Git fixtures (desktop and touch); the tests found and fixed three interaction bugs ([ADR 0011](docs/decisions/0011-interactive-technical-renderer.md)). P1-D done except the maintainer's private-GitHub rehearsal: watchers + reconciliation, remote caches with backoff, SSE, config reload, restart from cache; a live multi-repository test covers every exit item, and found and fixed a refresh livelock, a lost update, and a cache race ([ADR 0012](docs/decisions/0012-continuous-monitoring.md)). P1-E: demo mode, diagnostics (`status`, `cache`, `/api/diagnostics`), user guide, zero-dependency package with a CI install rehearsal on all OSes, measured targets met on a 2-core laptop (detection p95 0.9 s, idle CPU at baseline, 71 MiB); measuring found and fixed a Windows watch feedback loop, a reconcile pile-up, and excess Git processes ([ADR 0013](docs/decisions/0013-hardening-evidence.md)). P1-F: optional signed GitHub webhooks to an isolated loopback receiver with a safety poll and polling fallback ([ADR 0014](docs/decisions/0014-github-push-notifications.md)). Open: maintainer rehearsals (private GitHub, real webhook delivery, physical sleep/resume). Next: P2-A art direction. |
| P2 living garden | P2-A review candidate | Atlas and landscape (image-model generated), four lighting studies, equivalent Canvas/SVG geometry and shared interactions. Review fixed: garden preview had become the default and broke four Phase 1 tests; empty and unreadable repositories rendered as nothing (now soil beds and marker stakes; names and status stay hover/focus-only by design, section 7); focus targets under 44 px; per-frame atlas reloads; no exit control when focusing an empty repository (all renderers). Hillside per maintainer design: 64 fixed bush and icon positions checked against the backdrop image, even spreading, hover-only icons, cyan highlight, and click-the-plant focus (section 7). Measured: neither compositor, nor the technical view, meets the 100 ms interaction target at 2,000 commits ([ADR 0015](docs/decisions/0015-botanical-renderer-proof.md)). Next: maintainer visual and asset-licensing review, then overlay culling before P2-B. |
| P3 public stable release | Not started | Installation rehearsal and release gates |

The destination is a useful Git instrument that also makes a workspace more pleasant. Every stage should leave something runnable, understandable, and worth keeping, so the garden can grow through many small, well-verified contributions.
