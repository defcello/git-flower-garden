# HTTP API for renderers

The local service publishes the garden's Model, Git and environment data, as
JSON over HTTP. The browser UI is one client of it. A renderer written in any
language can be another: a Python script that drives an image or video model,
a game engine scene, a pixel display on a microcontroller.

The types below are defined in [`src/api/types.ts`](../src/api/types.ts),
which is the source of truth. This page explains how to use them.

## Connecting

The service listens on loopback only, `http://127.0.0.1:4783/` by default
(`server.port` in the configuration). `git-flower-garden demo` serves
fictional repositories on port 4784, so you can develop without your own
repositories.

The service refuses requests that look like they come from a web page on
another site:

- the `Host` header must name the loopback server (`127.0.0.1:<port>`,
  `localhost:<port>`, or `[::1]:<port>`), and
- a request with an `Origin` header from another origin is refused, and no
  CORS headers are sent.

Ordinary HTTP clients (curl, Python `requests`, Node `fetch`) send no `Origin`
header, so these rules don't affect them. A web page served from another
origin can't call the API. To build a browser renderer, add it to this
repository's UI ([renderers.md](renderers.md)).

Only `GET` and `HEAD` are accepted. The service never changes a repository
([ADR 0002](decisions/0002-read-only-source-policy.md)).

## Versioning

Every `/api/repositories` response and every event carries `apiVersion`
(currently `1`). Fields can be added without changing the version. Clients
must ignore fields they don't know. Removing or changing the meaning of a
field raises the version.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/events` | Server-sent events: a `repositories` event (a `RepositoriesJson`) on connect and on every change |
| `GET /api/repositories` | The same `RepositoriesJson`, once |
| `GET /api/repositories/<id>/graph` | `GraphJson`: the visible commit graph with layout. Returns 503 until the first read finishes |
| `GET /api/repositories/<id>/graph?reveal=<oid>,…` | The same graph, also showing up to 20 named commits |
| `GET /api/repositories/<id>/status` | One `RepositoryStatusJson` |
| `GET /api/repositories/<id>/tags?q=<text>` | Tags matching `q`, with the commits they point to |
| `GET /api/repositories/<id>/graph.svg` | A static SVG of the technical drawing |
| `GET /api/health`, `GET /api/diagnostics` | Liveness, and counters for troubleshooting |

## Staying current

1. Open `GET /api/events` and read `repositories` events. Comment lines that
   start with `:` are heartbeats.
2. For each repository whose `revision` is greater than 0 and whose `counts`
   is not null, fetch its graph again whenever `revision` or
   `display.windowStartMs` changes. Discard a graph response whose `revision`
   is older than one you already have.
3. If the connection drops, reconnect. The first event after a reconnect
   describes everything. A restarted service can restart revisions from 1, so
   after a reconnect, refetch graphs instead of comparing revisions with
   those from before.

[`src/ui/model/garden-model.ts`](../src/ui/model/garden-model.ts) implements
these steps for the browser. Use it as the reference implementation.

## What the data means

- **Repositories** (`RepositoryStatusJson`): `status.state` is one of
  `initializing`, `ready`, `stale`, `offline`, `error`, or `incomplete`.
  `remote` reports monitored remotes separately. `counts.reachableCommits` is
  `0` for a repository with no commits.
- **Graphs** (`GraphJson`): `nodes` are the visible commits. Each node has
  `reasons`: `head` is a branch head, `ancestor` is a common ancestor of
  branches, `recent` is recent work, and `worktree` is checked out in a
  worktree. Each node also has `refs` (tags are written `tag: <name>`) and
  `row` (higher rows are newer) and `lane`. `edges` link children to parents.
  A `collapsed` edge hides `hidden` commits. `tails` mark history below the
  window, and `boundary` tails mark missing history. `x`, `y`, and `size`
  give the technical layout in CSS pixels. Use it or ignore it.
- **Environment** (`display.environment`): the place (latitude, longitude,
  elevation, and time zone) and, when weather is enabled, the provider's
  normalized `weather.conditions` for the current hour
  ([ADR 0020](decisions/0020-weather-provider.md)). It is `null` when the
  sky is turned off. The Sun and Moon are not sent. The browser computes
  them from the place and the clock with the vendored astronomy-engine
  ([ADR 0019](decisions/0019-astronomy-engine-review.md)), and so can your
  renderer. Ports of astronomy-engine exist for C, C#, Python, and Kotlin.
- **Display** (`display`): `timeZone`, `businessDays`, `reducedMotion`
  (honor it), `notice` (show it), and `renderer`, which is the configured
  default view for browser renderers.

## Example: Python

```python
import json, urllib.request

BASE = "http://127.0.0.1:4784/api/"   # git-flower-garden demo

def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.load(response)

garden = get("repositories")
for repo in garden["repositories"]:
    if repo["revision"] > 0 and repo["counts"]:
        graph = get(f"repositories/{repo['id']}/graph")
        heads = [n for n in graph["nodes"] if "head" in n["reasons"]]
        print(repo["label"], repo["status"]["state"], len(heads), "branch heads")
```

For live updates, read `api/events` with any server-sent-events client and
refetch graphs as described in [Staying current](#staying-current).
