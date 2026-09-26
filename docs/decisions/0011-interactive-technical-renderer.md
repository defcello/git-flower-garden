# 0011: Interactive technical renderer (P1-C)

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 7, 9 (P1-C); completes the P0-A browser-test item

## Decisions

- **One layout, drawn by the browser.** The service computes selection and
  layout (ADRs 0009–0010) and serves them as JSON (`src/api/types.ts`, shared by
  server and UI). The React UI (`src/ui/`, Vite, built to `dist/ui/`) only draws.
  `/preview` keeps the static SVG view, which works without JavaScript.
- **One commit per row, whole row clickable.** Each commit has a full-width hit
  row, so hover and click targets are large and unambiguous.
- **Focus controls follow section 7.** On hover or keyboard focus, a 44×44
  circular `+` appears centered above the tree's lanes, with space reserved
  above the tree. The button lives inside the plot, so moving the pointer from
  tree to button keeps it visible. Touch screens (`hover: none`) always show it.
  `+` opens focus view, where `−` ("Show all repositories") sits in the same
  place. `−` or Escape restores the garden's scroll position and keyboard focus.
  Escape first closes open details.
- **Camera stability.** Focus view frames the tree once, at the first real
  container measurement. Live updates never move the camera. Pan and zoom are
  bounded (scale 0.3–4, at least 80 px of the drawing stays visible), "Fit"
  reframes, and commits that move above the view are announced with a button
  instead of being scrolled to. Clicking a commit pins details and never zooms.
- **Selection by commit ID.** A pinned commit is tracked by OID across updates.
  If it leaves the graph, the panel says so instead of silently showing another
  commit.
- **Accessibility.** Status is shown with a glyph plus a word, never color alone.
  Node kinds use shapes. Plots are focusable regions with names. Focus view has
  a commit list of named buttons, and details focus their heading. Reduced
  motion is honored from both the OS and the configuration.
- **Transport for now.** The UI polls status every 3 s and fetches a graph when
  its snapshot revision changes (or after 60 s, because the window moves with
  the clock). The service reconciles local sources on `monitor.localReconcileSeconds`.
  Server-sent events and watchers replace polling in P1-D.
- **CSP.** Scripts, styles, and fetches are same-origin only. Vite's build emits
  no inline script. React's CSSOM style updates are not affected by `style-src`.

## Browser tests

`npm run test:e2e` (Playwright) starts `tests/e2e/fixture-server.ts`: real Git
repositories, a clock pinned to Tuesday 2026-09-22 15:00 EDT, and 1 s
reconciliation. Tests drive the browser that is already installed (Edge on
Windows, Chrome on the macOS and Ubuntu runners), so no browser download is
needed.

| Section 7 behavior | Test |
| --- | --- |
| Garden lists every repository in config order with a worded status; empty and missing states | `garden view › shows every repository…` |
| Hover reveals a circular `+` of at least 44 px, above and centered over the tree; stays while the pointer moves onto it | `garden view › hovering a plot…` |
| Tooltip on hover; click pins full details (OID, tags, author, ordered parents) without scrolling or zooming | `garden view › hover shows a tooltip…` |
| Several refs on one commit are all discoverable; worktree marker | `garden view › several refs…` |
| Keyboard: focus a plot, `+`, commit list, Enter opens details, Escape closes details then exits; scroll and focus restored | `focus view › keyboard…` |
| `−` replaces `+` in the same place and restores the garden | `focus view › the − button…` |
| Bounded wheel zoom (max 4), Fit, drag pan with no click-through, bounded far drag, click keeps camera | `focus view › bounded pan and zoom…` |
| Live update: new commit appears without reload; selection stays on the same commit | `live updates › new commits appear…` |
| Selected commit leaves the graph: reported, not swapped | `live updates › a selected commit…` |
| Touch: `+` visible without hover; tap `+`, a commit, and `−` | `touch.spec.ts` (Pixel 7 emulation) |

## Bugs found by these tests

1. **Enter opened and immediately closed focus view.** Opening focus view on
   keydown moved focus to `−`, and the same Enter keystroke's keypress then
   activated it. A synthetic keydown-only test by hand missed it; Playwright's
   real key sequence caught it. Fix: `preventDefault()` on the handled keydown.
2. **First framing used a placeholder container size.** The first Fit framed
   the tree differently from later Fits. Framing now happens in the resize
   observer's first callback.
3. **A drag released outside the window kept panning on hover.** The pointer
   release never arrived. Drags now end on lost pointer capture, pointer cancel,
   or a mouse move with no button held.

React-hooks lint rules also removed a synchronous state update inside an effect
and a `Date.now()` call during render.

## Not yet

Server-sent events and reconnects, configuration reload, and removing a
repository while it is focused (the UI already returns to the garden when the
focused repository disappears; exercising it end to end needs config reload)
are P1-D. Persistent lane preferences across updates are deferred until real
repositories show lane churn.
