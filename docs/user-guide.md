# git-flower-garden user guide

git-flower-garden shows the live commit graphs of your Git repositories in a browser,
for a dedicated monitor or a spare window. It reads your repositories; it
never changes them. This guide covers version 0.3 (beta): the technical view
and the garden view.

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- [Git](https://git-scm.com/) 2.36 or newer on `PATH` (2.44 or newer recommended)
- A current Chrome, Edge, Firefox, or Safari

Windows, macOS, and Linux are supported.

## Install

git-flower-garden is distributed as a file on its [releases page](https://github.com/defcello/git-flower-garden/releases). Install
it with npm, using the file's link or a downloaded copy:

```sh
npm install --global https://github.com/defcello/git-flower-garden/releases/download/v<version>/defcello-git-flower-garden-<version>.tgz
# or, after downloading it:
npm install --global ./defcello-git-flower-garden-<version>.tgz
git-flower-garden --version
```

The package is `@defcello/git-flower-garden`; the command it installs is
`git-flower-garden`. Installing runs no install scripts and adds no other packages.
On Windows, a global install goes to your user profile and needs no
administrator rights.

On Windows, if PowerShell says running scripts is disabled, your system's
policy blocks npm's PowerShell launcher: run `git-flower-garden.cmd` instead (or use
Command Prompt). There is no need to change the policy.

**Update:** stop a running `git-flower-garden` (or `git-garden`), then
install the newer release with the same command. Your configuration and
cache are kept.

Coming from 0.2.0-beta.1, whose command was `git-garden`: the same install
command replaces it with `git-flower-garden`. On first run, the
`git-garden` configuration and cache folders move to their new names
(the output says so); nothing needs editing. If you started it at login,
change `git-garden serve` to `git-flower-garden serve` there.

Coming from 0.1 (installed from a source checkout as `git-garden`): install
the release as above. git-flower-garden then reminds you to remove the old
program with `npm uninstall --global git-garden`.

**Uninstall:** see [Diagnostics and data](#diagnostics-and-data).

Your configuration file is the only thing you need to edit. The installed
program files are not meant to be changed; an update replaces them.

## Try the demo

```sh
git-flower-garden demo
```

This opens fictional repositories at <http://127.0.0.1:4784/>. They need no
configuration, credentials, or network access. The demo's clock is fixed at
Tuesday 22 September 2026, 15:00 New York time, so its recent work stays
visible. Press Ctrl+C to stop; the demo repositories are then deleted.

## Set up your garden

```sh
git-flower-garden init-config                 # writes the per-user configuration file
# edit the file: add repositories (see below)
git-flower-garden validate-config             # checks the file and every repository
git-flower-garden serve                       # http://127.0.0.1:4783/
```

Press Ctrl+C to stop the service. To start it at login, add
`git-flower-garden serve` to your operating system's startup items. For a dedicated
monitor, open the page in a browser's fullscreen or kiosk mode.

The configuration file is:

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\git-flower-garden\config.json` |
| macOS | `~/Library/Application Support/git-flower-garden/config.json` |
| Linux | `$XDG_CONFIG_HOME/git-flower-garden/config.json` (usually `~/.config/…`) |

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
[git-flower-garden.example.json](../git-flower-garden.example.json). The JSON Schema
[git-flower-garden.schema.json](../git-flower-garden.schema.json) gives editors completion and
checking. Unknown keys are errors.

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | (required) | Must be `1` |
| `server.host` | `127.0.0.1` | Loopback only: `127.0.0.1`, `localhost`, or `::1` |
| `server.port` | `4783` | 1–65535 |
| `history.businessDays` | `2` | How many business days of recent commits to show (1–366) |
| `history.weekdays` | Monday–Friday | Which days count: `sun` … `sat` |
| `history.timeZone` | system zone | IANA name, e.g. `America/New_York` |
| `history.maxRecentCommits` | unlimited | Show at most this many of the newest recent commits per repository (1–100000); older ones fold into dashed stems with a hidden count. Branch heads, their common ancestors, and worktree HEADs always show |
| `monitor.localReconcileSeconds` | `5` | Change check for local repositories (1–3600) |
| `monitor.remotePollSeconds` | `60` | Remote fetch interval (10–86400); failures back off up to 15 minutes |
| `monitor.maxConcurrentFetches` | `2` | Fetches running at once across all repositories (1–16) |
| `monitor.fetchTimeoutSeconds` | `120` | Per-fetch limit; raise it for a very large first fetch (10–3600) |
| `display.reducedMotion` | `false` | Reduce motion further (the OS setting is always honored) |
| `environment.enabled` | `true` | Follow the real sun, moon, and stars in the garden view; `false` lights it by a fixed noon sun |
| `environment.latitude`, `environment.longitude` | Blacksburg, Virginia | Your location in degrees; north and east are positive. Give both or neither |
| `environment.elevationMeters` | `0` (Blacksburg: `634`) | Height above sea level |
| `environment.timeZone` | `history.timeZone` (Blacksburg: `America/New_York`) | Zone for the local time shown with the sky |
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
  git-flower-garden's own cache, and their *current* branches replace the clone's
  last-fetched tracking branches in the graph. Your clone is not fetched into
  or changed.
- **`url`**: a repository you have no clone of (`https`, `http`, `ssh`, `git`,
  `file`, or `user@host:path`). URLs with passwords or access tokens in them are rejected; use a
  credential helper or SSH agent instead.

### The sky

The garden view's sky follows the real sun and moon, over Blacksburg,
Virginia, until you give your own coordinates: dawn, daylight, dusk, twilight, and night, the moon's
phase (lit on the side facing the sun), and stars. The mountains, the hill,
and the plants are lit by that same sun and moon: shading follows where the
sun really is, backlit petals and grass glow, and a moonlit night is dim.
With `"enabled": false`, the garden is lit by a fixed noon sun. The focus
view always shows its plant in daylight, so it stays easy to read; after
dusk its panels, and the controls, turn dark.
Everything is computed on your computer; no location lookup happens and
nothing is sent anywhere. Weather is not available yet.

```json
"environment": { "latitude": 35.6, "longitude": -82.55 }
```

The sky is a panorama: east is always on the left and west on the right, with
the noon sun in the middle, whichever way your monitor faces. Heights above
the horizon are real. The **Time** slider (garden view) shows the sky at any
time of that day, and **Loop** plays the day round, a day every 30 seconds.
The **Sky** menu returns to **Live**, or jumps to a preview such as sunrise,
full moon, or polar night, which sets the slider, date, and place. Any
chosen time is labelled **Sky preview** and is never taken for live
conditions.

### Motion

In the garden view, leaves, flowers, and fruit sway gently in a breeze.
Only the artwork moves: what you point at, click, or tab to stays exactly
where it was. The focus view holds its plant still, for reading, and so
does the garden for the plant you point at or tab to while it is outlined,
and for a plant showing a last-known state (stale or incomplete). The
**Drawing** menu (garden view) chooses how the garden is drawn:

- **Auto** (the default): GPU when the browser has graphics hardware for
  WebGL2, otherwise Software.
- **GPU**: the sky, landscape, and plants are drawn and relit by the
  graphics processor, so moving the time of day or looping it is smooth,
  and swaying costs less. Chosen by hand, it also
  runs where WebGL2 exists only in software (slowly). If the graphics
  processor resets, the garden switches to Software until it recovers.
- **Software**: drawn on the CPU, animating at most 15 frames a second.
  If the computer cannot keep up, the sway stops for the rest of the visit.
- **Static**: nothing moves between lighting changes, not even new growth.
  The lowest-power choice for an always-on display.

The choice is remembered in this browser. Your operating system's reduce
motion setting, or `display.reducedMotion`, stops all motion whatever the
choice. Nothing is drawn while the page is hidden.

## Authentication troubleshooting

git-flower-garden uses your existing Git setup (credential helpers, SSH agent, and
`insteadOf` rules), and it never prompts. If a remote shows "authentication
needed":

1. In a terminal, run `git ls-remote <url>` (or `git ls-remote origin` inside the
   clone). git-flower-garden can fetch once this works without prompting.
2. GitHub over HTTPS: `gh auth setup-git` configures Git to use the GitHub
   CLI's login. Being logged in to `gh` alone is not enough.
3. SSH: make sure your key is loaded (`ssh-add -l`) and the host is in
   `known_hosts` (connect once with `ssh -T git@github.com`).
4. On Windows, Git Credential Manager must have a stored credential. Run one
   `git fetch` in a terminal to store it.

## Faster remote updates with GitHub push notifications (optional)

By default git-flower-garden checks remotes every `monitor.remotePollSeconds`. For
GitHub repositories you administer, GitHub can notify git-flower-garden right after
a push. git-flower-garden then fetches at once, and keeps a slow safety poll
(`webhooks.safetyPollSeconds`, default 5 minutes) in case a notification is
lost.

1. **Choose a secret** (at least 16 characters) and put it in an environment
   variable for git-flower-garden: `GIT_FLOWER_GARDEN_WEBHOOK_SECRET`, or another name set
   in `webhooks.secretEnv`. The secret never goes in the configuration file.
2. **Enable the receiver:** `"webhooks": { "enabled": true }`. It listens on
   `http://127.0.0.1:4785/github/webhook` (`webhooks.port`) and nowhere else. It
   is separate from the viewer and has no other routes.
3. **Expose only that address to GitHub** with a tunnel or reverse proxy you
   run (for example Cloudflare Tunnel, ngrok, or Tailscale Funnel, all of which
   have free tiers), forwarding a public HTTPS URL to
   `http://127.0.0.1:4785/github/webhook`. Do not expose the viewer's port.
4. **Add a webhook** in the GitHub repository's *Settings → Webhooks* (repository
   admin rights needed): payload URL = your public URL, content type =
   `application/json`, secret = your secret, events = *Pushes*, *Branch or tag
   creation*, and *Branch or tag deletion*.
5. **Map the repository.** Sources with a github.com `url` are mapped
   automatically. For a local clone, add `"github": "owner/name"`, or rely on its
   monitored `remotes` pointing at github.com.

The page shows each remote's last notification next to its last fetch. If the
secret is missing or the receiver cannot start, the page says so and ordinary
polling continues.

**Rotating the secret:** set the new value in the environment variable,
restart git-flower-garden, then update the secret in GitHub's webhook settings.
Notifications that arrive in between are rejected; the safety poll covers the
gap.

## Diagnostics and data

```sh
git-flower-garden status        # the running service: per-repository state, timings, cache sizes
git-flower-garden cache         # cache sizes; --clean <id> or --clean-all removes caches
```

`http://127.0.0.1:4783/api/diagnostics` returns the same information as JSON.

git-flower-garden keeps fetched remote objects in a per-user cache:
`%LOCALAPPDATA%\git-flower-garden\Cache` (Windows), `~/Library/Caches/git-flower-garden`
(macOS), or `$XDG_CACHE_HOME/git-flower-garden` (Linux). This is private repository
data. Removing a repository from the configuration stops monitoring it but
keeps its cache; `git-flower-garden cache --clean <id>` deletes it. Nothing else is
stored, and nothing is sent anywhere except fetches to your own remotes.

**Uninstall:**

```sh
git-flower-garden cache --clean-all        # optional: remove cached remote data
npm uninstall --global @defcello/git-flower-garden
```

This removes the program and the `git-flower-garden` command. Your configuration
file stays for a later install; to remove it, delete its `git-flower-garden` folder
(`%APPDATA%git-flower-garden` on Windows, `~/Library/Application Support/git-flower-garden`
on macOS, `~/.config/git-flower-garden` on Linux). If you used `git-flower-garden demo` and
closed its window instead of pressing Ctrl+C, the next demo removes the
leftover temporary folder.

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

## Known limitations

- The garden view is a preview. Its lighting is recomputed every minute or two
  rather than continuously, and shadows are simple. Weather is not built
  yet.
- There is no "retry now" button for a failing remote; it retries on its own
  with backoff (at most 15 minutes).
- For a local repository with monitored `remotes`, remote *tags* come from the
  clone, not the remote.
- GitHub push notifications need your own tunnel or reverse proxy; there is
  no hosted relay, and GitHub Apps are not supported.
- Holidays are not excluded from business days.
- After a restart, local repositories are re-read before their graphs appear
  (typically about a second each); remote-only repositories show their cached
  state at once.
