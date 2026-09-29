# git-flower-garden

Watch your Git repositories as a live graph in your browser: every branch
head, the common ancestors that connect them, and the last few business days
of work, with older history compressed honestly. A garden view draws each
repository as a plant on a hillside.

git-flower-garden only reads your repositories; it never changes them. It runs on
your own computer and serves its page to your browser only
(<http://127.0.0.1>, not reachable from the network).

This is a **beta** ({{VERSION}}).

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- [Git](https://git-scm.com/) 2.36 or newer

## Install

```sh
npm install --global {{INSTALL}}
git-flower-garden --version
```

Or download the `.tgz` file from the [releases page]({{RELEASES}}) and run
`npm install --global ./<file>.tgz`.

The package is `{{PACKAGE}}`; the command is `git-flower-garden`. Installing runs no install scripts and adds no
other packages.

On Windows, if PowerShell says running scripts is disabled, your system's
policy blocks npm's PowerShell launcher: run `git-flower-garden.cmd` instead (or use
Command Prompt). There is no need to change the policy.

## Get started

```sh
git-flower-garden demo                 # fictional repositories, no setup needed
git-flower-garden init-config          # create your configuration file
git-flower-garden validate-config      # check it
git-flower-garden serve                # open http://127.0.0.1:4783/
```

`init-config` prints where your configuration file is. Add your repositories
to it; each has an `id` and a local `path` or a remote `url`:

```json
{
  "version": 1,
  "repositories": [{ "id": "website", "path": "C:/work/website" }]
}
```

The [user guide](docs/user-guide.md) (installed with the package) covers every
setting. Your configuration file is the only thing you need to edit; the
installed program files are not meant to be changed.

## Update

Stop a running `git-flower-garden` (or `git-garden`), then install the newer
release the same way, with its file or URL from the
[releases page]({{RELEASES}}). Your configuration and cache are kept.

From 0.2.0-beta.1, whose command was `git-garden`: the new command
`git-flower-garden` replaces it, and its first run moves your configuration
and cache folders to the new name. From 0.1: git-flower-garden reminds you to
remove the old program with `npm uninstall --global git-garden`.

## Uninstall

```sh
git-flower-garden cache --clean-all    # optional: remove cached remote data first
npm uninstall --global {{PACKAGE}}
```

Uninstalling removes the program and the `git-flower-garden` command. Your
configuration file stays, so a later install picks it up. To remove it too,
delete the `git-flower-garden` folder that holds it:

| System | Configuration | Cache |
| --- | --- | --- |
| Windows | `%APPDATA%\git-flower-garden` | `%LOCALAPPDATA%\git-flower-garden` |
| macOS | `~/Library/Application Support/git-flower-garden` | `~/Library/Caches/git-flower-garden` |
| Linux | `$XDG_CONFIG_HOME/git-flower-garden` (`~/.config/git-flower-garden`) | `$XDG_CACHE_HOME/git-flower-garden` (`~/.cache/git-flower-garden`) |

## What it stores and runs

- **Files:** your configuration file, and a cache of remote history for
  sources you configure with a `url` or `remotes`. Nothing else, and nothing
  inside your repositories. `git-flower-garden demo` works in a temporary folder that
  it removes when you stop it.
- **Processes:** one `node` process while it runs, which starts short-lived
  `git` commands to read your repositories.
- **Network:** fetches only the remotes you configure, using your existing Git
  credentials. It sends no telemetry and checks for no updates.

## Source and license

Source, issues, and releases: <{{REPOSITORY}}>. MIT license.
