# git-garden user guide

git-garden shows the live commit graphs of your Git repositories in a browser,
for a dedicated monitor or a spare window. It reads your repositories; it
never changes them. This guide covers version 0.1 (the technical view; the
garden artwork comes later).

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- [Git](https://git-scm.com/) 2.36 or newer on `PATH` (2.44 or newer recommended)
- A current Chrome, Edge, Firefox, or Safari

Windows, macOS, and Linux are supported.

## Install

From a release tarball (`git-garden-<version>.tgz`):

```sh
npm install --global ./git-garden-0.1.0.tgz
git-garden --version
```

From source:

```sh
git clone https://github.com/defcello/git-garden.git
cd git-garden
npm ci
npm run build
node dist/cli.js --version        # or: npm install --global .
```

## Try the demo

```sh
git-garden demo
```

This opens fictional repositories at <http://127.0.0.1:4784/>. They need no
configuration, credentials, or network access. The demo's clock is fixed at
Tuesday 22 September 2026, 15:00 New York time, so its recent work stays
visible. Press Ctrl+C to stop; the demo repositories are then deleted.

## Set up your garden

```sh
git-garden init-config                 # writes the per-user configuration file
# edit the file: add repositories (see below)
git-garden validate-config             # checks the file and every repository
git-garden serve                       # http://127.0.0.1:4783/
```

Press Ctrl+C to stop the service. To start it at login, add
`git-garden serve` to your operating system's startup items. For a dedicated
monitor, open the page in a browser's fullscreen or kiosk mode.

The configuration file is:

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\git-garden\config.json` |
| macOS | `~/Library/Application Support/git-garden/config.json` |
| Linux | `$XDG_CONFIG_HOME/git-garden/config.json` (usually `~/.config/…`) |

Use `--config <file>` with any command to pick another file. Changes to the
file apply while the service runs. If an edit is invalid, the previous valid
configuration stays in use and the page lists the problems. Changing
`server.host` or `server.port` needs a restart; the page says so.

## Reading the view

Each repository is a plot. Newer commits are higher and parents are lower;
each row is one commit.

| Mark | Meaning |
| --- | --- |
| Filled disc with a ring | A branch head (local or remote) |
| Filled disc | A recent commit (in the recent-history window) |
| Hollow diamond | A best common ancestor of two or more branch heads |
| Small square | A worktree has this commit checked out |
| Solid line | A parent link |
| Dotted line with a number | Hidden commits between two shown commits; `…` means more than one hidden path |
| Dotted stub below a commit | Older history continues below |
| Red stub | History is missing (shallow clone or unavailable objects) |

**What is shown:** every branch head, however old; every best common ancestor
of any combination of two or more heads; every commit in the recent-history
window; and every worktree's checked-out commit. Everything else is hidden
behind dotted lines. A quiet repository therefore stays short, while its
branch structure stays exact.

**The recent-history window** runs from the start of the Nth most recent
business day to now, in your configured time zone (default: the last 2
business days, Monday–Friday). On a Monday, that means Friday, the weekend,
and Monday so far. It measures commit time, not push time.

**Status** appears under each repository name, in words and symbols:
● up to date, ◐ incomplete (e.g. shallow clone), ◷ last known state (a read
failed; the previous graph stays), ✕ error. Monitored remotes get their own
line: when they were last fetched and when the next check is due.

### Controls

| Action | Mouse | Touch | Keyboard |
| --- | --- | --- | --- |
| Focus one repository | Hover the plot, click the round **+** above its tree | Tap **+** (always visible) | Tab to the plot, then Enter (or Tab to **+**) |
| Back to all repositories | **−** | Tap **−** | Escape |
| Commit summary | Hover a row | | |
| Commit details (message, all names, dates, parents, worktrees) | Click a row | Tap a row | In focus view, Tab to the commit list, Enter |
| Close details | × | × | Escape |
| Zoom / pan (focus view) | Wheel / drag, or the toolbar | | Zoom in, Zoom out, Fit buttons |

A selected commit stays selected through live updates. If it leaves the graph
(its branch was deleted, or it aged out of the window), the details panel
says so.

## Configuration reference

A complete example is in
[git-garden.example.json](../git-garden.example.json). The JSON Schema
[git-garden.schema.json](../git-garden.schema.json) gives editors completion and
checking. Unknown keys are errors.

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | (required) | Must be `1` |
| `server.host` | `127.0.0.1` | Loopback only: `127.0.0.1`, `localhost`, or `::1` |
| `server.port` | `4783` | 1–65535 |
| `history.businessDays` | `2` | How many business days of recent commits to show (1–366) |
| `history.weekdays` | Monday–Friday | Which days count: `sun` … `sat` |
| `history.timeZone` | system zone | IANA name, e.g. `America/New_York` |
| `monitor.localReconcileSeconds` | `5` | Change check for local repositories (1–3600) |
| `monitor.remotePollSeconds` | `60` | Remote fetch interval (10–86400); failures back off up to 15 minutes |
| `monitor.maxConcurrentFetches` | `2` | Fetches running at once across all repositories (1–16) |
| `monitor.fetchTimeoutSeconds` | `120` | Per-fetch limit; raise it for a very large first fetch (10–3600) |
| `display.reducedMotion` | `false` | Reduce motion further (the OS setting is always honored) |
| `repositories` | (required) | List of sources, below. `[]` shows a welcome page. |

Each repository needs a unique `id` (lowercase letters, digits, `.`, `_`, or
`-`) and exactly one source:

```json
{ "id": "work", "label": "Work project", "path": "C:/code/work" }
{ "id": "work", "path": "../work", "remotes": ["origin"] }
{ "id": "upstream", "url": "https://github.com/OWNER/REPO.git" }
```

- **`path`**: a local repository or any worktree of it. Relative paths are
  relative to the configuration file. Listing two worktrees of the same
  repository is rejected (they share one graph).
- **`remotes`** (with `path`): these remotes are also fetched, into
  git-garden's own cache, and their *current* branches replace the clone's
  last-fetched tracking branches in the graph. Your clone is not fetched into
  or changed.
- **`url`**: a repository you have no clone of (`https`, `http`, `ssh`, `git`,
  `file`, or `user@host:path`). URLs with passwords in them are rejected; use a
  credential helper or SSH agent instead.

## Authentication troubleshooting

git-garden uses your existing Git setup (credential helpers, SSH agent, and
`insteadOf` rules), and it never prompts. If a remote shows "authentication
needed":

1. In a terminal, run `git ls-remote <url>` (or `git ls-remote origin` inside the
   clone). git-garden can fetch once this works without prompting.
2. GitHub over HTTPS: `gh auth setup-git` configures Git to use the GitHub
   CLI's login. Being logged in to `gh` alone is not enough.
3. SSH: make sure your key is loaded (`ssh-add -l`) and the host is in
   `known_hosts` (connect once with `ssh -T git@github.com`).
4. On Windows, Git Credential Manager must have a stored credential. Run one
   `git fetch` in a terminal to store it.

## Diagnostics and data

```sh
git-garden status        # the running service: per-repository state, timings, cache sizes
git-garden cache         # cache sizes; --clean <id> or --clean-all removes caches
```

`http://127.0.0.1:4783/api/diagnostics` returns the same information as JSON.

git-garden keeps fetched remote objects in a per-user cache:
`%LOCALAPPDATA%\git-garden\Cache` (Windows), `~/Library/Caches/git-garden`
(macOS), or `$XDG_CACHE_HOME/git-garden` (Linux). This is private repository
data. Removing a repository from the configuration stops monitoring it but
keeps its cache; `git-garden cache --clean <id>` deletes it. Nothing else is
stored, and nothing is sent anywhere except fetches to your own remotes.

**Uninstall:** `npm uninstall --global git-garden`, then delete the
configuration file and the cache directory above.

## Supported sizes

Measured on a 2-core laptop with 4 GB of RAM (see
[ADR 0013](decisions/0013-hardening-evidence.md)): with 10 repositories, changes
appear in under a second, idle CPU is negligible, and the service uses about
70 MB. A 100,000-commit repository is read cold in about 3 seconds. Designed
for up to about 10 repositories of up to 100,000 commits and 100 branches each.
Larger repositories work but take longer to read. A million commits takes
seconds per read, reported as loading rather than dropped.

## Security

The service listens only on the loopback interface. It answers only requests
addressed to itself (checked Host header), refuses cross-origin requests, and
has no endpoint that changes anything. Repository text is always shown as
text. See [SECURITY.md](../SECURITY.md) to report a problem.

## Known limitations (0.1)

- The garden artwork, weather, and sky are not built yet; this is the
  technical view.
- There is no "retry now" button for a failing remote; it retries on its own
  with backoff (at most 15 minutes).
- For a local repository with monitored `remotes`, remote *tags* come from the
  clone, not the remote.
- GitHub push notifications (webhooks) are not supported yet; remotes are
  polled.
- Holidays are not excluded from business days.
- After a restart, local repositories are re-read before their graphs appear
  (typically about a second each); remote-only repositories show their cached
  state at once.
