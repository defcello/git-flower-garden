# Changelog

All notable changes to git-garden. The project follows
[semantic versioning](https://semver.org/); before 1.0, minor versions may
change configuration or behavior, and the notes say how.

## 0.2.0-beta.1: garden beta (unreleased)

Install with `npm install --global git-garden-app` (the command is still
`git-garden`). The package contains only the finished program: no sources,
source maps, or development tooling, and no install scripts.


- **Garden preview** (roadmap Phase 2, P2-A review candidate, not yet
  accepted): botanical artwork over the same graph, as Canvas and SVG
  compositors, with four lighting studies. On a Blue Ridge hillside, up to 64
  repositories grow from fixed positions; names, status, and focus icons
  appear on hover. The technical view remains the default.
  ([ADR 0015](docs/decisions/0015-botanical-renderer-proof.md))
- Garden plants follow the graph: stems taper by branch flow (forks thinner,
  merges wider, thicker lower down), crossings keep a clear depth order, and
  new growth, moved branch heads, and removed history animate briefly
  (never with reduced motion). ([ADR 0017](docs/decisions/0017-botanical-graph-rules.md))
- Faster focus view for large histories: off-screen rows are skipped and
  unreadable text is not drawn when zoomed far out. ([ADR 0016](docs/decisions/0016-focus-view-culling.md))
- Fixed: focusing an empty repository offered no control to return to the
  garden (Escape still worked).

## 0.1.0: functional preview (2026-09-27)

The technical view: a reliable, live, gitk-style graph of many repositories.
Roadmap Phase 1 ([ROADMAP.md](ROADMAP.md)); design decisions and evidence in
[docs/decisions](docs/decisions/).

### Added

- **Graph selection** that keeps every branch head, every best common ancestor
  of any combination of heads, every commit of the last N business days (time
  zone and DST aware), and worktree HEADs. Everything else is compressed into
  marked edges with exact hidden-commit counts, and nothing is invented.
  Checked against independent oracles and Git itself.
- **Interactive browser view:** a garden of repository plots, a circular
  `+`/`−` focus control, hover tooltips, pinned commit details, pan and zoom,
  keyboard and touch support, an accessible commit list, and light and dark
  themes.
- **Live monitoring:** file watchers with cheap fingerprint reconciliation for
  local repositories; remote-only sources and monitored remotes fetched into a
  private cache with backoff; server-sent events; configuration reload;
  last-known state after restart.
- **Optional GitHub push notifications** through an isolated, signed webhook
  receiver behind your own tunnel, with a safety poll.
- **CLI:** `init-config`, `validate-config`, `serve`, `demo`, `status`, `cache`.
- **Strict, versioned configuration** with line/column error messages and a
  JSON Schema.
- **Safety:** monitored repositories are never modified (verified byte for byte
  in tests); loopback-only service with Host/Origin checks and a strict CSP.
- **Documentation:** a [user guide](docs/user-guide.md) and 14 decision records.

### Known limitations

See the user guide's "Known limitations". The garden artwork (Phase 2) is not
included.
