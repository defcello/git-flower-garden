# 0014: Optional GitHub push notifications (P1-F)

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 5.3, 9 (P1-F), 13

## Decision

- **Topology:** a per-repository GitHub webhook delivered to a small receiver
  that git-garden runs on loopback, exposed by a tunnel or reverse proxy the
  user operates. No hosted relay, and no infrastructure git-garden sets up.
  Costs are the user's tunnel (free tiers exist) and nothing else.
- **Per-repository webhook, not a GitHub App.** A webhook needs only repository
  admin rights and a shared secret, and each user sets it up for themselves. A
  GitHub App needs an app registration, a private key, installation per
  account, and somewhere reachable to host it. For one person's monitor, that
  adds setup and secrets with no benefit. Revisit if multiple users want to
  share one receiver.
- **Receiver contract** (`src/server/webhook.ts`): its own listener with one
  route, `POST /github/webhook`. The body is capped at 1 MiB (checked from the
  declared length and while streaming). The HMAC-SHA256 signature over the raw
  body is compared in constant time. Events allowed: `push`, `create`,
  `delete` (`ping` gets a reply). A window of the last 1,000 delivery IDs drops
  duplicates. It acknowledges with 202 before any work and never uses payload
  contents beyond the repository name.
- **Effect of a notification:** it's only a hint. Each configured repository
  mapped to that "owner/name" (by `github`, a github.com `url`, or a github.com
  remote URL of a monitored remote) fetches now, or right after a fetch in
  progress. The fetch-and-reconcile path is the same as polling, so
  duplicates, reordering, and missed deliveries can't corrupt the graph.
  Force-pushed intermediate states that were never fetched cannot be
  reconstructed; this is a current-state monitor.
- **Safety net:** while the receiver is active, webhook-covered remotes poll
  every `webhooks.safetyPollSeconds` (default 5 minutes) instead of
  `monitor.remotePollSeconds`. If the secret is missing or the receiver can't
  listen, the page says why, and all remotes keep ordinary polling.
- **Freshness:** each remote reports its last notification separately from
  its last successful fetch, so a notification alone never claims the graph is
  current.
- **Secrets:** read from an environment variable named in the configuration
  (default `GIT_GARDEN_WEBHOOK_SECRET`), at least 16 characters, never stored in
  the file. Rotation: set the new value, restart, and update GitHub. The safety
  poll covers the gap.

## Security review against roadmap section 13

| Requirement | How |
| --- | --- |
| Isolated from the local API | Separate `http.Server`; no UI, no API, no Git commands; no route besides the webhook path |
| No request chooses a path, command, executable, or URL | The payload yields only a repository name, matched against configured mappings; unknown names do nothing |
| Signature over the raw body, safe comparison | `timingSafeEqual` on equal-length buffers; tampered bodies are rejected |
| Bounded payloads and state | 1 MiB cap; dedup window of 1,000 IDs; per-repository fetches coalesce (a notification during a fetch sets one "fetch again" flag) |
| A tunnel exposes only the receiver | Loopback bind; the guide says to forward only `/github/webhook`, never the viewer port |

## Evidence

`tests/server/webhook.test.ts`:

- A signed push is accepted and reported.
- Forged, unsigned, truncated-signature, and tampered deliveries → 401,
  nothing triggered.
- A body over 1 MiB → 413; `GET` → 405; other paths → 404.
- A duplicate delivery ID is dropped; `ping` gets `pong`; irrelevant events,
  non-JSON bodies, and payloads without a repository are ignored; out-of-order
  deliveries are harmless.
- End to end, with ordinary polling set to an hour: nothing updates until a
  signed notification arrives, then the pushed commit appears. Notifications
  for other repositories change nothing.
- With notifications "lost", the safety poll still picks up the push.
- With no secret set, the receiver reports the problem and polling continues.

## Not verified

A real GitHub delivery through a real tunnel needs a repository the
maintainer administers and a tunnel account, so it is left to the maintainer.
Follow the user guide's setup, then push and watch the remote line show
"notified … ago" followed by the new commit.
