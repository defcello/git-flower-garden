#!/usr/bin/env node
/**
 * git-flower-garden command line.
 *
 *   git-flower-garden init-config [--config <file>]
 *   git-flower-garden validate-config [--config <file>]
 *   git-flower-garden serve [--config <file>] [--port <n>]
 *   git-flower-garden demo [--port <n>]
 *   git-flower-garden status [--config <file>]
 *   git-flower-garden cache [--config <file>] [--clean <id> | --clean-all]
 *
 * Without --config, the per-user configuration file is used.
 */
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  formatConfigError,
  parseConfig,
  systemTimeZone,
  type Config,
} from "./config/config.ts";
import {
  defaultCacheDir,
  defaultConfigPath,
  migrateLegacyFolders,
} from "./config/paths.ts";
import { startDemo } from "./demo/run-demo.ts";
import {
  detectGitVersion,
  isSupportedGitVersion,
  MINIMUM_GIT_VERSION,
} from "./git/version.ts";
import {
  cachedRepositoryIds,
  directorySize,
  removeRepositoryCache,
  repositoryCacheDir,
} from "./monitor/cache.ts";
import { inspectSources } from "./monitor/sources.ts";
import { startApp } from "./server/app.ts";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        resolve(dirname(import.meta.filename), "../package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * git-flower-garden 0.1 was the npm package `git-garden`, which installing
 * this package does not remove, so its `git-garden` command lingers. Returns
 * how to remove it when that package sits beside this one in the global
 * `node_modules` and is this project's (the unscoped name `git-garden`
 * otherwise belongs to an unrelated tool).
 */
export function legacyInstallNote(
  here: string = dirname(import.meta.filename),
): string | null {
  // <global node_modules>/@defcello/git-flower-garden/dist/cli.js
  const pkg = resolve(here, "../../..", "git-garden", "package.json");
  try {
    const { repository } = JSON.parse(readFileSync(pkg, "utf8")) as {
      repository?: { url?: string };
    };
    if (
      !/github\.com\/defcello\/git-(flower-)?garden\b/.test(
        repository?.url ?? "",
      )
    )
      return null;
  } catch {
    return null;
  }
  return "git-flower-garden 0.1 (named git-garden) is still installed, with its own git-garden command. Remove it with: npm uninstall --global git-garden";
}

const COMMANDS = [
  "init-config",
  "validate-config",
  "serve",
  "demo",
  "status",
  "cache",
];

const USAGE = `Usage: git-flower-garden <command> [options]

Commands:
  init-config       Write a starter configuration file
  validate-config   Check the configuration file and its repositories
  serve             Start the viewer at http://127.0.0.1:<port>/ (Ctrl+C stops it)
  demo              Serve fictional demo repositories; needs no configuration
  status            Show the running service's per-repository diagnostics
  cache             Show cache sizes; --clean <id> or --clean-all removes caches

Options:
  --config <file>     Configuration file (default: ${defaultConfigPath()})
  --port <n>          Override server.port (serve, demo)
  --cache-dir <dir>   Cache directory (default: ${defaultCacheDir()})
  -h, --help          Show this help
  -v, --version       Show the version
`;

function starterConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      history: {
        businessDays: 2,
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        timeZone: systemTimeZone(),
      },
      repositories: [],
    },
    null,
    2,
  )}\n`;
}

async function loadConfig(file: string, io: Io): Promise<Config | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    io.err(
      `${file}: cannot read configuration. Create one with: git-flower-garden init-config --config "${file}"`,
    );
    return null;
  }
  const result = parseConfig(text, dirname(file));
  if (!result.ok) {
    for (const e of result.errors) io.err(formatConfigError(file, e));
    io.err(
      `${String(result.errors.length)} problem(s) found; the configuration was not loaded.`,
    );
    return null;
  }
  return result.config;
}

async function checkGit(io: Io): Promise<boolean> {
  try {
    const found = await detectGitVersion(process.cwd());
    if (isSupportedGitVersion(found)) {
      if (found.major === 2 && found.minor < 44) {
        io.err(
          `Note: ${found.raw} predates GIT_NO_LAZY_FETCH (Git 2.44). git-flower-garden only reads commits and refs, which partial clones always contain, but upgrading Git is recommended.`,
        );
      }
      return true;
    }
    const min = MINIMUM_GIT_VERSION;
    io.err(
      `${found.raw} is too old; git-flower-garden needs Git ${String(min.major)}.${String(min.minor)} or newer.`,
    );
  } catch {
    io.err("Git was not found on PATH. Install Git 2.36 or newer.");
  }
  return false;
}

function parsePort(
  value: string | undefined,
  io: Io,
): number | null | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.err("--port must be an integer from 0 to 65535");
    return null;
  }
  return port;
}

function untilStopped(close: () => Promise<void>): Promise<void> {
  return new Promise<void>((done) => {
    const stop = () => {
      void close().then(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** GET a JSON document from a running service on loopback. */
function getLocal(host: string, port: number, path: string): Promise<unknown> {
  const hostHeader = `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        headers: { Host: hostHeader, Accept: "application/json" },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(body));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

interface DiagnosticsBody {
  process: { uptimeSeconds: number; rssBytes: number; eventClients: number };
  cacheRoot: string;
  configErrors: string[];
  repositories: {
    id: string;
    status: { state: string; diagnostic: string | null };
    remote: {
      state: string;
      lastSuccess: number | null;
      diagnostic: string | null;
    } | null;
    counts: { reachableCommits: number; visibleCommits: number | null } | null;
    timings: {
      lastReadMs: number | null;
      lastGraphMs: number | null;
      lastFetchMs: number | null;
      fetchFailures: number;
    };
    cacheBytes: number | null;
    watching: boolean;
  }[];
}

export async function main(
  argv: readonly string[],
  io: Io = { out: console.log, err: console.error },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        config: { type: "string" },
        port: { type: "string" },
        "cache-dir": { type: "string" },
        clean: { type: "string" },
        "clean-all": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }
  if (parsed.values.version) {
    io.out(`git-flower-garden ${version()}`);
    return 0;
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help || command === undefined || command === "help") {
    io.out(USAGE);
    return command === undefined && !parsed.values.help ? 2 : 0;
  }
  if (extra.length > 0) {
    io.err(`Unexpected argument: ${extra.join(" ")}`);
    return 2;
  }
  // Only for real commands, so a typo never moves the user's folders.
  if (COMMANDS.includes(command)) {
    for (const note of await migrateLegacyFolders({
      config: parsed.values.config === undefined,
      cache: parsed.values["cache-dir"] === undefined,
    }))
      io.err(note);
    const legacy = legacyInstallNote();
    if (legacy) io.err(legacy);
  }
  const file = resolve(parsed.values.config ?? defaultConfigPath());
  const cacheRoot = resolve(parsed.values["cache-dir"] ?? defaultCacheDir());
  const port = parsePort(parsed.values.port, io);
  if (port === null) return 2;

  switch (command) {
    case "init-config": {
      try {
        // It lists private repository paths and URLs: the user's alone.
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, starterConfig(), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          io.err(`${file} already exists; it was left unchanged.`);
          return 1;
        }
        throw error;
      }
      io.out(`Wrote ${file}`);
      io.out(
        'Add repositories, e.g. { "id": "my-project", "path": "C:/code/my-project" }, then run: git-flower-garden validate-config',
      );
      return 0;
    }
    case "validate-config": {
      const config = await loadConfig(file, io);
      if (!config) return 1;
      if (!(await checkGit(io))) return 1;
      const checks = await inspectSources(config);
      let problems = 0;
      for (const check of checks) {
        for (const problem of check.problems) {
          io.err(`${file}: repository "${check.id}": ${problem}`);
          problems++;
        }
      }
      if (problems > 0) {
        io.err(`${String(problems)} problem(s) found.`);
        return 1;
      }
      io.out(
        `${file} is valid: ${String(config.repositories.length)} repositor${config.repositories.length === 1 ? "y" : "ies"}.`,
      );
      return 0;
    }
    case "serve": {
      const config = await loadConfig(file, io);
      if (!config) return 1;
      if (!(await checkGit(io))) return 1;
      if (port !== undefined) config.server.port = port;
      let app;
      try {
        app = await startApp(config, {
          configPath: file,
          cacheRoot,
          waitForFirstRead: false,
          ...(port === undefined ? {} : { port }),
        });
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      io.out(
        `git-flower-garden ${version()} is serving ${String(config.repositories.length)} repositories at ${app.url}`,
      );
      io.out("Press Ctrl+C to stop.");
      await untilStopped(() => app.close());
      return 0;
    }
    case "demo": {
      if (!(await checkGit(io))) return 1;
      let demo;
      try {
        demo = await startDemo({ port: port ?? 4784 });
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      io.out(
        `git-flower-garden demo is serving fictional repositories at ${demo.app.url}`,
      );
      io.out("Press Ctrl+C to stop; the demo repositories are then deleted.");
      await untilStopped(() => demo.close());
      return 0;
    }
    case "status": {
      const config = await loadConfig(file, io);
      if (!config) return 1;
      const listenPort = port ?? config.server.port;
      let body: DiagnosticsBody;
      try {
        body = (await getLocal(
          config.server.host,
          listenPort,
          "/api/diagnostics",
        )) as DiagnosticsBody;
      } catch {
        io.err(
          `git-flower-garden is not running at http://${config.server.host}:${String(listenPort)}/`,
        );
        return 1;
      }
      io.out(
        `git-flower-garden at http://${config.server.host}:${String(listenPort)}/ · up ${String(body.process.uptimeSeconds)} s · ${mib(body.process.rssBytes)} RSS · ${String(body.process.eventClients)} viewer(s)`,
      );
      for (const e of body.configErrors) io.err(`configuration: ${e}`);
      for (const r of body.repositories) {
        const counts = r.counts
          ? `${String(r.counts.visibleCommits ?? "?")}/${String(r.counts.reachableCommits)} commits`
          : "no snapshot";
        const remote = r.remote
          ? ` · remote ${r.remote.state}${r.remote.lastSuccess ? ` (fetched ${new Date(r.remote.lastSuccess).toISOString()})` : ""}`
          : "";
        const timings = `read ${String(r.timings.lastReadMs ?? "-")} ms, graph ${String(r.timings.lastGraphMs ?? "-")} ms${r.timings.lastFetchMs !== null ? `, fetch ${String(r.timings.lastFetchMs)} ms` : ""}`;
        const cache =
          r.cacheBytes !== null ? ` · cache ${mib(r.cacheBytes)}` : "";
        io.out(
          `  ${r.id}: ${r.status.state} · ${counts}${remote} · ${timings}${cache}${r.watching ? "" : " · not watching (reconcile only)"}`,
        );
        if (r.status.diagnostic) io.out(`      ${r.status.diagnostic}`);
        if (r.remote?.diagnostic)
          io.out(`      remote: ${r.remote.diagnostic}`);
      }
      return 0;
    }
    case "cache": {
      const configured = new Set(
        await readFile(file, "utf8").then(
          (text) => {
            const r = parseConfig(text, dirname(file));
            return r.ok ? r.config.repositories.map((x) => x.id) : [];
          },
          () => [] as string[],
        ),
      );
      const ids = await cachedRepositoryIds(cacheRoot);
      const clean = parsed.values["clean-all"]
        ? ids
        : parsed.values.clean !== undefined
          ? [parsed.values.clean]
          : [];
      if (clean.length > 0) {
        for (const id of clean) {
          if (!ids.includes(id)) {
            io.err(`No cache for "${id}" in ${cacheRoot}`);
            return 1;
          }
        }
        for (const id of clean) {
          await removeRepositoryCache(cacheRoot, id);
          io.out(`Removed ${repositoryCacheDir(cacheRoot, id)}`);
        }
        io.out("A running service re-fetches what it still monitors.");
        return 0;
      }
      io.out(`Cache directory: ${cacheRoot}`);
      if (ids.length === 0) io.out("  (empty)");
      let total = 0;
      for (const id of ids) {
        const size = await directorySize(repositoryCacheDir(cacheRoot, id));
        total += size;
        io.out(
          `  ${id}: ${mib(size)}${configured.has(id) ? "" : " (not in the configuration; remove with --clean)"}`,
        );
      }
      if (ids.length > 0) io.out(`  total: ${mib(total)}`);
      return 0;
    }
    default:
      io.err(`Unknown command: ${command}`);
      io.err(USAGE);
      return 2;
  }
}

// Run when executed directly (not when imported by tests).
// Compare real paths: npm installs the command as a symlink (macOS, Linux),
// and temporary directories can be symlinks too (macOS /var -> /private/var).
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
if (
  process.argv[1] !== undefined &&
  realPath(process.argv[1]) === realPath(import.meta.filename)
) {
  process.exitCode = await main(process.argv.slice(2));
}
