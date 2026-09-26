# Security policy

git-garden reads private repositories and runs a local web service, so security
reports are welcome.

## Supported versions

There is no release yet. Security fixes land on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's
**Report a vulnerability** button on this repository's Security tab (private
vulnerability reporting). If that option is unavailable, open a public issue that
only asks for a private contact channel, without technical details.

Please include affected files or versions, steps to reproduce, and the impact you
expect. This is a volunteer project, so response times are best effort. You
should get an acknowledgement within two weeks.

## Scope

In scope, for example:

- A web page on another origin reading private commit data from the local service,
  or triggering Git commands through it.
- Any path by which git-garden modifies a monitored repository, its hooks, or the
  user's Git configuration or credentials.
- Command or argument injection through configuration, ref names, commit
  messages, or remote URLs.
- Credentials or private paths leaking into logs, error messages, or the UI.
- Escaping or markup injection in rendered repository text.

Out of scope: vulnerabilities in Git itself, in credential helpers, or in the
user's browser, unless git-garden makes them worse.
