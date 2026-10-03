# Changelog

All notable changes to git-flower-garden (formerly git-garden). The project
follows
[semantic versioning](https://semver.org/); before 1.0, minor versions may
change configuration or behavior, and the notes say how.

## Unreleased

### Changes

- **Grass moves with the wind.** The hill is covered in dense painted
  grass tufts that bend with the live forecast's wind: leaning downwind as
  it blows, and swept together by waves that roll across the hill as the
  gusts pass, paler where the grass bends and darker where it stands up,
  settling in the lulls, more so the stronger the wind. Tufts nearer than a plant
  grow in front of its stem; the plants catch the same gusts. The hill
  beneath is a new, plainer ground. Low, Static, reduced motion, and
  hidden pages hold the grass still; the view's note says when reduced
  motion or late frames are holding the garden still.
  ([ADR 0021](docs/decisions/0021-grass-sprites.md))
- **Optional weather.** Set `environment.weather.enabled` to show this
  hour's forecast (cloud, rain, sleet or snow, wind, temperature) from MET
  Norway's free service in the garden view's details, labelled as a model
  forecast with its hour, fetch time, and credit. It is off by default
  because it sends your configured place (rounded to about 11 m) to
  `api.met.no`, from the service, about every half hour; an optional
  `contact` identifies you to MET Norway. Failed requests leave the last
  forecast marked stale, then no weather after 6 hours; the sky and Git
  monitoring are unaffected.
  ([ADR 0020](docs/decisions/0020-weather-provider.md))
- **The garden shows the weather.** Clouds drift across the sky and dull
  the sunlight, rain, sleet, or snow falls over the hillside, fog hazes
  the hill, plants sway harder in the wind, and sunlit showers may bring a
  rainbow, placed, sized, and coloured by the optics of water drops
  (inferred from the forecast, and said so). Rain and snow fall in front of the
  plants but never cover an icon, card, or label, and the focus view stays
  dry. A new **Weather** menu previews any condition, labelled as a
  preview. On a first-generation Surface Pro, heavy rain costs about 2% of
  a core more with the GPU, 8% in Software; Static holds it still.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))
- **Quality presets, High by default.** A new **Quality** menu beside
  Drawing chooses High (30 frames a second, the default), Balanced (15,
  as the garden animated before), or Low (10, plants hold still while
  the weather and light move, half the rain and snow, standard
  resolution). If a computer cannot keep up with High, the garden drops
  to 15 frames a second for the visit. **Behavior change**: on older
  computers High costs about twice the CPU of the previous behavior (on a
  first-generation Surface Pro, about one core with the GPU instead of
  half); choose Balanced for the previous behavior, or Low or Static to
  save more. ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))

- **The garden sways.** In the garden view, leaves, flowers, and fruit rock
  gently in a breeze; what you point at, click, or tab to never moves, and
  the focus view holds still. A new **Drawing** menu chooses Auto,
  Software (animated at up to 15 frames a second), or Static (nothing
  moves between lighting changes, the lowest-power choice). Reduced motion
  stops all motion. Swaying takes noticeable CPU on older computers
  (about one core of a first-generation Surface Pro); choose Static for an
  always-on display on such a machine.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))
- **The garden is drawn as one scene.** With the Canvas preview, every
  plant on the hillside is drawn into one canvas instead of one per
  repository, which is what the planned graphics-accelerated drawing
  needs. Swaying costs less (about 80% of one core of a first-generation
  Surface Pro for eight plants, down from 100%), and a full hillside of 64
  plants now sways instead of stopping. The plant you point at or tab to,
  and a plant showing a last-known state, hold still.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))

- **The garden can be drawn by the graphics processor.** The Drawing
  menu gains **GPU**, and Auto now chooses it when the browser has
  graphics hardware for WebGL2 (not a software stand-in) and its first
  frames are fast enough. The sky, Sun, Moon, stars, mountains, hill, and
  plants are relit on the graphics processor, matching Software's
  picture. Dragging or looping the time of
  day is smooth: on a first-generation Surface Pro the whole scene follows
  at the display's rate, against about 3 repaints a second in Software,
  and swaying costs about half a core for eight plants, against four
  fifths. If the graphics processor resets, the garden falls back to
  Software until it recovers.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))

## 0.3.0-beta.1: renamed, real sky (2026-09-28)

Install or update from the
[release](https://github.com/defcello/git-flower-garden/releases/tag/v0.3.0-beta.1):
`npm install --global <link to the .tgz file>`. Stop a running
`git-garden` first. Coming from 0.2.0-beta.1, the same command replaces
`git-garden` with `git-flower-garden`, and the first run moves your folders
(below); from 0.1, git-flower-garden tells you how to remove the old
program. Both upgrades are rehearsed on Windows, macOS, and Linux before
each release.

### Security

- **Remote URLs no longer appear on Git's command line.** Fetches pass the
  URL to Git through its environment, which other users on the same
  computer cannot read, unlike a process's arguments. This matters for a
  local clone whose remote URL contains a token.
- **Access tokens in configured URLs are rejected**, like passwords
  already were (for example `https://ghp_…@github.com/…`); use a credential
  helper or SSH agent. A configuration with one no longer loads until it is
  removed; the error says where.
- **Private files are private.** The cache of fetched repositories and a
  configuration file written by `init-config` are now readable by you
  alone; an existing cache folder is tightened on the next fetch.
- The build and release workflows pin their GitHub Actions to exact
  commits.

### Changes

- **The garden is lit by the real sun and moon.** The painted daytime
  backdrop is replaced by separate mountain and hill layers, relit together
  with the flowers, leaves, fruit, and stems from the sun's and moon's actual
  positions: low sun from the side, backlit petals and grass, dim moonlit
  nights. Lighting runs on the CPU in the background about once a minute or
  two, so no graphics acceleration is needed. The focus view shows its plant
  in daylight for legibility. Loading the garden view now downloads about
  11 MB of artwork from the local service.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md))

- **Real-time sky** in the garden view: set `environment.enabled` with your
  latitude and longitude, and the sky follows the sun and moon, computed
  offline (no location lookup, nothing sent anywhere). The Sky menu replaces
  the four lighting studies with Live and a set of labelled previews
  (sunrise, full moon, polar night, and more). The package now includes
  `THIRD-PARTY-NOTICES.md`.
  ([ADR 0018](docs/decisions/0018-two-tier-scene-renderer.md),
  [ADR 0019](docs/decisions/0019-astronomy-engine-review.md))

- **Renamed to git-flower-garden.** The command is now `git-flower-garden`;
  there is no `git-garden` alias, because an unrelated npm package uses that
  name. Installing over an earlier release replaces the old command. On
  first run, the per-user configuration and cache
  folders named `git-garden` are moved to `git-flower-garden` (only when the
  new folder does not exist yet, and only for defaults, not `--config` or
  `--cache-dir`). The default webhook secret variable is now
  `GIT_FLOWER_GARDEN_WEBHOOK_SECRET`; `GIT_GARDEN_WEBHOOK_SECRET` is still read
  when it is unset. The schema and example files are now
  `git-flower-garden.schema.json` and `git-flower-garden.example.json`; a
  configuration's `$schema` pointing at the old file name still loads.

## 0.2.0-beta.1: garden beta (2026-09-27)

Install from the [release](https://github.com/defcello/git-flower-garden/releases/tag/v0.2.0-beta.1):
`npm install --global <link to the .tgz file>`. The package is
`@defcello/git-flower-garden`; the command is still `git-garden`. The package contains only the finished program: no sources,
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
