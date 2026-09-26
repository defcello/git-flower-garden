#!/usr/bin/env node
/**
 * git-garden command line.
 *
 *   git-garden init-config [--config <file>]
 *   git-garden validate-config [--config <file>]
 *   git-garden serve [--config <file>] [--port <n>]
 *
 * Without --config, the per-user configuration file is used.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  formatConfigError,
  parseConfig,
  systemTimeZone,
  type Config,
} from "./config/config.ts";
import { defaultConfigPath } from "./config/paths.ts";
import {
  detectGitVersion,
  isSupportedGitVersion,
  MINIMUM_GIT_VERSION,
} from "./git/version.ts";
import { RepositoryService } from "./monitor/repository-service.ts";
import { inspectSources } from "./monitor/sources.ts";
import { startServer } from "./server/server.ts";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: git-garden <command> [options]

Commands:
  init-config       Write a starter configuration file
  validate-config   Check the configuration file and its repositories
  serve             Start the local viewer at http://127.0.0.1:<port>/

Options:
  --config <file>   Configuration file (default: ${defaultConfigPath()})
  --port <n>        Override server.port for serve
  -h, --help        Show this help
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
      `${file}: cannot read configuration. Create one with: git-garden init-config --config "${file}"`,
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
    const version = await detectGitVersion(process.cwd());
    if (isSupportedGitVersion(version)) {
      if (version.major === 2 && version.minor < 44) {
        io.err(
          `Note: ${version.raw} predates GIT_NO_LAZY_FETCH (Git 2.44). git-garden only reads commits and refs, which partial clones always contain, but upgrading Git is recommended.`,
        );
      }
      return true;
    }
    const min = MINIMUM_GIT_VERSION;
    io.err(
      `${version.raw} is too old; git-garden needs Git ${String(min.major)}.${String(min.minor)} or newer.`,
    );
  } catch {
    io.err("Git was not found on PATH. Install Git 2.36 or newer.");
  }
  return false;
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
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
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
  const file = resolve(parsed.values.config ?? defaultConfigPath());

  switch (command) {
    case "init-config": {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, starterConfig(), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          io.err(`${file} already exists; it was left unchanged.`);
          return 1;
        }
        throw error;
      }
      io.out(`Wrote ${file}`);
      io.out(
        'Add repositories, e.g. { "id": "my-project", "path": "C:/code/my-project" }, then run: git-garden validate-config',
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
      if (parsed.values.port !== undefined) {
        const port = Number(parsed.values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          io.err(`--port must be an integer from 0 to 65535`);
          return 2;
        }
        config.server.port = port;
      }
      const service = new RepositoryService(config);
      await service.refreshAll();
      let started;
      try {
        started = await startServer(
          service,
          config.server.host,
          config.server.port,
        );
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      io.out(
        `git-garden is serving ${String(config.repositories.length)} repositories at ${started.url}`,
      );
      io.out("Press Ctrl+C to stop.");
      await new Promise<void>((done) => {
        const stop = () => {
          void started.close().then(done);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    default:
      io.err(`Unknown command: ${command}`);
      io.err(USAGE);
      return 2;
  }
}

// Run when executed directly (not when imported by tests).
const invoked = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (
  invoked === resolve(import.meta.filename) ||
  invoked === resolve(import.meta.filename).replace(/\.ts$/, ".js")
) {
  process.exitCode = await main(process.argv.slice(2));
}
