# 0001: Local loopback service with a browser UI

- Status: Accepted
- Date: 2026-09-26
- Roadmap: sections 3, 5, 13

## Context

git-flower-garden must read local Git repositories and filesystem metadata, fetch remotes
with the user's existing credentials, and display continuously on a dedicated
monitor. Browsers cannot run Git or watch the filesystem. A desktop shell
(Electron, Tauri) would add packaging, signing, and update work before the first
graph exists.

## Decision

Run git-flower-garden as a local background process that owns all Git and filesystem
access, and serve the UI to an ordinary browser over loopback HTTP. The service
pushes updates with server-sent events and answers ordinary HTTP reads. There is
no git-flower-garden account, hosted service, database, or telemetry.

The service binds to `127.0.0.1` by default and rejects non-loopback hosts until
authenticated hosting is designed separately. It validates `Host`/`Origin`, avoids
permissive CORS, and exposes no endpoint that accepts a path, Git command, or
arbitrary URL from a request.

## Consequences

- Any browser in kiosk or fullscreen mode can drive the dedicated monitor.
- Service and UI share TypeScript contracts ([0006](0006-toolchain-baseline.md)).
- A local web server is an attack surface for other pages in the same browser,
  so the loopback and origin rules above are requirements, not hardening extras.
- A desktop wrapper can later host the same service and UI unchanged.

## Revisit

At P3, if installation rehearsals show that starting a service and opening a
browser is a real obstacle, or if auto-launch needs a native wrapper.
