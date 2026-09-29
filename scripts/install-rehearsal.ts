/*
 * Release rehearsal: install the staged release package globally, use it as
 * a new user would, update it, remove its data, uninstall it, and check that
 * nothing is left behind. Then upgrade to it from the published
 * 0.2.0-beta.1 (whose command was `git-garden`) and from a 0.1 install (the
 * npm package `git-garden`), as existing users will.
 *
 *   npm run release:stage && npm run rehearse:install
 *
 * Each scenario runs in its own sandbox: its own npm prefix and cache, and a
 * fake home (config, cache, and temp folders), so every file the tool writes
 * is accounted for. Runs in CI on Windows, macOS, and Linux. The upgrade
 * scenario downloads the published beta once (checked against its SHA-256)
 * into release/legacy/.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli?.endsWith(".js")) {
  throw new Error("Run this through npm: npm run rehearse:install");
}
const windows = process.platform === "win32";
const step = (text: string) => {
  console.log(`\n== ${text}`);
};

/** The last published release, which existing users upgrade from. */
const BETA = {
  version: "0.2.0-beta.1",
  file: "defcello-git-flower-garden-0.2.0-beta.1.tgz",
  url: "https://github.com/defcello/git-flower-garden/releases/download/v0.2.0-beta.1/defcello-git-flower-garden-0.2.0-beta.1.tgz",
  sha256: "4d45a8ebb6e6b4f5f6cb7d66efb71334c7684bd5cb47caac474133261e6820a3",
};

const staged = JSON.parse(
  await readFile(join(repoRoot, "release", "stage", "package.json"), "utf8"),
) as { name: string; version: string };
// npm names a scoped package's tarball "scope-name-version.tgz".
const tarball = join(
  repoRoot,
  "release",
  `${staged.name.replace(/^@/, "").replace("/", "-")}-${staged.version}.tgz`,
);
if (!existsSync(tarball))
  throw new Error(`No staged package at ${tarball}; run npm run release:stage`);

const work = await mkdtemp(join(tmpdir(), "git-flower-garden-release-"));

async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}
const listed = async (dir: string) =>
  (await files(dir)).map((f) => relative(dir, f).split(sep).join("/"));

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    request(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        resolvePromise({ status: res.statusCode ?? 0, body });
      });
    })
      .on("error", reject)
      .end();
  });
}

async function waitFor(what: string, probe: () => Promise<boolean>) {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > 60_000) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sha = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** A scratch npm prefix and home in which commands run as a user's would. */
async function sandbox(name: string) {
  const base = join(work, name);
  const prefix = join(base, "prefix");
  const npmCache = join(base, "npm-cache");
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    TMPDIR: join(home, "tmp"),
    npm_config_update_notifier: "false",
  };
  for (const dir of [prefix, npmCache, cwd, join(home, "tmp")])
    await mkdir(dir, { recursive: true });

  const run = (cmd: string, args: string[]): string =>
    execFileSync(cmd, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  const npm = (args: string[]) =>
    run(process.execPath, [
      npmCli as string,
      ...args,
      "--prefix",
      prefix,
      "--cache",
      npmCache,
      "--no-audit",
      "--no-fund",
    ]);
  /** An installed command's launcher, as a shell would run it. */
  const shim = (command: string) =>
    windows ? join(prefix, `${command}.cmd`) : join(prefix, "bin", command);
  const shell = (command: string, args: string[]): [string, string[]] =>
    windows
      ? [
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", shim(command), ...args],
        ]
      : [shim(command), args];
  const cli = (command: string, args: string[]) => run(...shell(command, args));
  /** Run a command; return its exit code and both output streams. */
  const capture = (command: string, args: string[]) => {
    const r = spawnSync(...shell(command, args), {
      cwd,
      env,
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  /**
   * Start an installed command, wait for its URL, run checks, then stop it:
   * with Ctrl+C (SIGINT) where the platform can send one, else by killing it.
   */
  async function withServer(
    args: string[],
    check: (url: string) => Promise<void>,
  ): Promise<void> {
    const [cmd, cmdArgs] = shell("git-flower-garden", args);
    const child = spawn(cmd, cmdArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<void>((r) => {
      child.on("exit", () => {
        r();
      });
    });
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let out = "";
        const timer = setTimeout(() => {
          reject(new Error(`no URL printed; output so far:\n${out}`));
        }, 60_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
          const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
          if (match?.[1]) {
            clearTimeout(timer);
            resolveUrl(match[1]);
          }
        });
        child.on("exit", (code) => {
          reject(new Error(`exited early with code ${String(code)}:\n${out}`));
        });
      });
      await check(url);
    } finally {
      if (windows && child.pid !== undefined) {
        // cmd.exe runs node as a child: end the whole tree.
        try {
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
          });
        } catch {
          // Already gone.
        }
      } else {
        child.kill("SIGINT");
      }
      await exited;
    }
  }

  /** Serve the configured repository and wait until it is read. */
  const serveSelf = () =>
    withServer(["serve", "--port", "0"], async (url) => {
      if ((await get(`${url}api/health`)).status !== 200)
        throw new Error("health check failed");
      const page = await get(url);
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
      if (!script || (await get(new URL(script, url).href)).status !== 200)
        throw new Error("UI not served");
      await waitFor("repository ready", async () =>
        // CI checkouts are shallow, which is reported honestly as "incomplete".
        /"state":"(ready|incomplete)"/.test(
          (await get(`${url}api/repositories`)).body,
        ),
      );
      console.log(`served ${url}: health, UI, and repository ready`);
    });

  /** The one configuration file under the home folder. */
  const configFile = async () => {
    const configs = (await files(home)).filter((f) =>
      f.endsWith("config.json"),
    );
    if (configs.length !== 1 || !configs[0])
      throw new Error(`expected one config file, found ${configs.join(", ")}`);
    return configs[0];
  };
  /** Point the configuration at this checkout. */
  const addSelf = async (config: string) => {
    const starter = JSON.parse(await readFile(config, "utf8")) as {
      repositories: unknown[];
    };
    starter.repositories = [{ id: "self", path: repoRoot }];
    await writeFile(config, JSON.stringify(starter, null, 2));
  };

  return {
    base,
    prefix,
    home,
    env,
    npm,
    shim,
    cli,
    capture,
    withServer,
    serveSelf,
    configFile,
    addSelf,
  };
}

/** The published beta, downloaded once and checked against its SHA-256. */
async function betaTarball(): Promise<string> {
  const dir = join(repoRoot, "release", "legacy");
  const file = join(dir, BETA.file);
  if (!existsSync(file) || (await sha(file)) !== BETA.sha256) {
    const response = await fetch(BETA.url);
    if (!response.ok)
      throw new Error(`${BETA.url}: HTTP ${String(response.status)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  if ((await sha(file)) !== BETA.sha256)
    throw new Error(`${BETA.file}: SHA-256 does not match the release`);
  return file;
}

async function freshInstall(): Promise<void> {
  const s = await sandbox("fresh");

  step(`install ${relative(repoRoot, tarball)} globally`);
  s.npm(["install", "--global", tarball]);
  if (!existsSync(s.shim("git-flower-garden")))
    throw new Error(`command not installed: ${s.shim("git-flower-garden")}`);
  const installedFiles = await listed(s.prefix);
  console.log(`${String(installedFiles.length)} files under the npm prefix`);
  if (installedFiles.some((f) => /\.(map|ts)$/.test(f) && !f.endsWith(".d.ts")))
    throw new Error("installed sources or source maps");

  step("git-flower-garden --version");
  const version = s.cli("git-flower-garden", ["--version"]).trim();
  console.log(version);
  if (version !== `git-flower-garden ${staged.version}`)
    throw new Error(`unexpected version: ${version}`);

  step("init-config and validate-config at the default location");
  console.log(s.cli("git-flower-garden", ["init-config"]).trim());
  const config = await s.configFile();
  await s.addSelf(config);
  console.log(s.cli("git-flower-garden", ["validate-config"]).trim());

  step("serve with the default cache");
  await s.serveSelf();

  step("demo, twice (a killed demo's folder is swept by the next)");
  for (let round = 0; round < 2; round++) {
    await s.withServer(["demo", "--port", "0"], async (url) => {
      await waitFor("five demo repositories", async () => {
        const body = JSON.parse((await get(`${url}api/repositories`)).body) as {
          repositories: { status: { state: string } }[];
        };
        return (
          body.repositories.length === 5 &&
          body.repositories.every((r) => r.status.state === "ready")
        );
      });
    });
  }
  const demoLeft = (await readdir(join(s.home, "tmp"))).filter((n) =>
    n.startsWith("git-flower-garden-demo-"),
  );
  // Ctrl+C removes it; a killed demo (Windows here) leaves one, never more.
  if (demoLeft.length > (windows ? 1 : 0))
    throw new Error(`demo folders left behind: ${demoLeft.join(", ")}`);
  console.log(`demo folders left in temp: ${String(demoLeft.length)}`);

  step("update to a newer version");
  const configBefore = await sha(config);
  const next = join(s.base, "next");
  await cp(join(repoRoot, "release", "stage"), next, { recursive: true });
  const nextVersion = `${staged.version}.rehearsal`;
  const manifest = JSON.parse(
    await readFile(join(next, "package.json"), "utf8"),
  ) as { version: string };
  manifest.version = nextVersion;
  await writeFile(join(next, "package.json"), JSON.stringify(manifest));
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [npmCli as string, "pack", "--json", "--pack-destination", s.base],
      { cwd: next, env: s.env, encoding: "utf8" },
    ),
  ) as { filename: string }[];
  s.npm(["install", "--global", join(s.base, packed[0]?.filename ?? "")]);
  const updated = s.cli("git-flower-garden", ["--version"]).trim();
  console.log(updated);
  if (updated !== `git-flower-garden ${nextVersion}`)
    throw new Error(`update did not take: ${updated}`);
  if ((await sha(config)) !== configBefore)
    throw new Error("the update changed the configuration file");
  console.log("configuration kept");

  step("remove cached data, then uninstall");
  console.log(s.cli("git-flower-garden", ["cache", "--clean-all"]).trim());
  s.npm(["uninstall", "--global", staged.name]);
  const leftInPrefix = await listed(s.prefix);
  if (leftInPrefix.length > 0)
    throw new Error(`left in the npm prefix:\n${leftInPrefix.join("\n")}`);
  console.log("npm prefix: no files left");

  step("what remains in the home folder");
  const leftInHome = (await listed(s.home)).filter(
    (f) =>
      !f.startsWith("tmp/git-flower-garden-demo-") &&
      // npm itself enables Node's compile cache in temp for its own runs.
      !f.startsWith("tmp/node-compile-cache/"),
  );
  console.log(leftInHome.join("\n") || "(nothing)");
  const allowed = [
    /^AppData\/Roaming\/git-flower-garden\/config\.json$/,
    /^\.config\/git-flower-garden\/config\.json$/,
    /^Library\/Application Support\/git-flower-garden\/config\.json$/,
    // Cache index files kept after --clean-all (no repository data).
    /^(AppData\/Local\/git-flower-garden\/Cache|\.cache\/git-flower-garden|Library\/Caches\/git-flower-garden)\/[^/]+\.json$/,
  ];
  const unexpected = leftInHome.filter((f) => !allowed.some((a) => a.test(f)));
  if (unexpected.length > 0)
    throw new Error(`unexpected files in home:\n${unexpected.join("\n")}`);
  if (!leftInHome.some((f) => f.endsWith("config.json")))
    throw new Error("the configuration file should survive an uninstall");
}

async function upgradeFromEarlierReleases(): Promise<void> {
  const s = await sandbox("upgrade");
  const commandGone = (command: string) =>
    !existsSync(s.shim(command)) &&
    !existsSync(join(s.prefix, `${command}.ps1`)) &&
    !existsSync(join(s.prefix, command));

  step(`install the published ${BETA.version} (command: git-garden)`);
  s.npm(["install", "--global", await betaTarball()]);
  console.log(s.cli("git-garden", ["--version"]).trim());
  console.log(s.cli("git-garden", ["init-config"]).trim());
  const oldConfig = await s.configFile();
  if (!/[/\\]git-garden[/\\]config\.json$/.test(oldConfig))
    throw new Error(`unexpected beta configuration path: ${oldConfig}`);
  await s.addSelf(oldConfig);
  const configBefore = await sha(oldConfig);

  step(`upgrade to ${staged.version} with the same install command`);
  s.npm(["install", "--global", tarball]);
  if (!commandGone("git-garden"))
    throw new Error("the upgrade left the old git-garden command behind");
  console.log("old git-garden command removed");
  const first = s.capture("git-flower-garden", ["validate-config"]);
  console.log(`${first.stdout}${first.stderr}`.trim());
  if (first.status !== 0 || !/Moved .*git-garden/.test(first.stderr))
    throw new Error("the first run did not move the git-garden folders");
  const newConfig = await s.configFile();
  if (!/[/\\]git-flower-garden[/\\]config\.json$/.test(newConfig))
    throw new Error(`configuration not moved: ${newConfig}`);
  if ((await sha(newConfig)) !== configBefore)
    throw new Error("the upgrade changed the configuration file");
  console.log("configuration moved to the new folder, unchanged");
  await s.serveSelf();

  step("a leftover 0.1 install (npm package git-garden, from a checkout)");
  const legacy = join(s.base, "git-garden-0.1");
  await mkdir(legacy, { recursive: true });
  await writeFile(
    join(legacy, "package.json"),
    JSON.stringify({
      name: "git-garden",
      version: "0.1.0",
      bin: { "git-garden": "cli.js" },
      repository: {
        type: "git",
        url: "git+https://github.com/defcello/git-garden.git",
      },
    }),
  );
  await writeFile(
    join(legacy, "cli.js"),
    '#!/usr/bin/env node\nconsole.log("git-garden 0.1.0");\n',
  );
  s.npm(["install", "--global", legacy]);
  const hinted = s.capture("git-flower-garden", ["validate-config"]);
  console.log(hinted.stderr.trim());
  if (!hinted.stderr.includes("npm uninstall --global git-garden"))
    throw new Error("no hint to remove the 0.1 install");
  s.npm(["uninstall", "--global", "git-garden"]);
  const after = s.capture("git-flower-garden", ["validate-config"]);
  if (after.stderr.includes("git-garden") || !commandGone("git-garden"))
    throw new Error("the 0.1 install is still reported after removing it");
  console.log("following the hint removes it; the hint then stops");

  step("uninstall");
  s.npm(["uninstall", "--global", staged.name]);
  const leftInPrefix = await listed(s.prefix);
  if (leftInPrefix.length > 0)
    throw new Error(`left in the npm prefix:\n${leftInPrefix.join("\n")}`);
  console.log("npm prefix: no files left");
}

try {
  await freshInstall();
  await upgradeFromEarlierReleases();
  console.log(
    `\nRelease rehearsal passed: install, use, update, and uninstall, with only the configuration file left; and upgrade from ${BETA.version} and 0.1.`,
  );
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
