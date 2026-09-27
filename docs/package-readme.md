# git-garden

Watch your Git repositories as a live graph in your browser: every branch
head, the common ancestors that connect them, and the last few business days
of work, with older history compressed honestly. A garden view draws each
repository as a plant on a hillside.

git-garden only reads your repositories; it never changes them. It runs on
your own computer and serves its page to your browser only
(<http://127.0.0.1>, not reachable from the network).

This is a **beta** ({{VERSION}}).

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- [Git](https://git-scm.com/) 2.36 or newer

## Install

```sh
npm install --global {{INSTALL}}
git-garden --version
```

Or download the `.tgz` file from the [releases page]({{RELEASES}}) and run
`npm install --global ./<file>.tgz`.

The package is `{{PACKAGE}}`; the command is `git-garden`. Installing runs no install scripts and adds no
other packages.

On Windows, if PowerShell says running scripts is disabled, your system's
policy blocks npm's PowerShell launcher: run `git-garden.cmd` instead (or use
Command Prompt). There is no need to change the policy.

## Get started

```sh
git-garden demo                 # fictional repositories, no setup needed
git-garden init-config          # create your configuration file
git-garden validate-config      # check it
git-garden serve                # open http://127.0.0.1:4783/
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

Install a newer release the same way, with its file or URL from the
[releases page]({{RELEASES}}). Your configuration and cache are kept. Stop a
running `git-garden` first.

## Uninstall

```sh
git-garden cache --clean-all    # optional: remove cached remote data first
npm uninstall --global {{PACKAGE}}
```

Uninstalling removes the program and the `git-garden` command. Your
configuration file stays, so a later install picks it up. To remove it too,
delete the `git-garden` folder that holds it:

| System | Configuration | Cache |
| --- | --- | --- |
| Windows | `%APPDATA%\git-garden` | `%LOCALAPPDATA%\git-garden` |
| macOS | `~/Library/Application Support/git-garden` | `~/Library/Caches/git-garden` |
| Linux | `$XDG_CONFIG_HOME/git-garden` (`~/.config/git-garden`) | `$XDG_CACHE_HOME/git-garden` (`~/.cache/git-garden`) |

## What it stores and runs

- **Files:** your configuration file, and a cache of remote history for
  sources you configure with a `url` or `remotes`. Nothing else, and nothing
  inside your repositories. `git-garden demo` works in a temporary folder that
  it removes when you stop it.
- **Processes:** one `node` process while it runs, which starts short-lived
  `git` commands to read your repositories.
- **Network:** fetches only the remotes you configure, using your existing Git
  credentials. It sends no telemetry and checks for no updates.

## Source and license

Source, issues, and releases: <{{REPOSITORY}}>. MIT license.
