/*
 * Release rehearsal: install the staged release package globally, use it as
 * a new user would, update it, remove its data, uninstall it, and check that
 * nothing is left behind.
 *
 *   npm run release:stage && npm run rehearse:install
 *
 * Everything happens in a scratch directory: its own npm prefix and cache,
 * and a fake home (config, cache, and temp folders), so every file the tool
 * writes is accounted for. Runs in CI on Windows, macOS, and Linux.
 */
import { execFileSync, spawn } from "node:child_process";
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
const prefix = join(work, "prefix");
const npmCache = join(work, "npm-cache");
const home = join(work, "home");
const cwd = join(work, "cwd");
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

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}
const npm = (args: string[]) =>
  run(process.execPath, [
    npmCli,
    ...args,
    "--prefix",
    prefix,
    "--cache",
    npmCache,
    "--no-audit",
    "--no-fund",
  ]);
/** The installed `git-flower-garden` command, as a shell would run it. */
const shim = windows
  ? join(prefix, "git-flower-garden.cmd")
  : join(prefix, "bin", "git-flower-garden");
const gitFlowerGarden = (args: string[]) =>
  windows
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", shim, ...args])
    : run(shim, args);

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

/**
 * Start the installed command, wait for its URL, run checks, then stop it:
 * with Ctrl+C (SIGINT) where the platform can send one, else by killing it.
 */
async function withServer(
  args: string[],
  check: (url: string) => Promise<void>,
): Promise<void> {
  const child = windows
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", shim, ...args],
        {
          cwd,
          env,
          stdio: ["ignore", "pipe", "inherit"],
        },
      )
    : spawn(shim, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
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

const sha = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

try {
  step(`install ${relative(repoRoot, tarball)} globally`);
  npm(["install", "--global", tarball]);
  if (!existsSync(shim)) throw new Error(`command not installed: ${shim}`);
  const installedFiles = await listed(prefix);
  console.log(`${String(installedFiles.length)} files under the npm prefix`);
  if (installedFiles.some((f) => /\.(map|ts)$/.test(f) && !f.endsWith(".d.ts")))
    throw new Error("installed sources or source maps");

  step("git-flower-garden --version");
  const version = gitFlowerGarden(["--version"]).trim();
  console.log(version);
  if (version !== `git-flower-garden ${staged.version}`)
    throw new Error(`unexpected version: ${version}`);

  step("init-config and validate-config at the default location");
  console.log(gitFlowerGarden(["init-config"]).trim());
  const configs = (await files(home)).filter((f) => f.endsWith("config.json"));
  const config = configs[0];
  if (configs.length !== 1 || !config)
    throw new Error(`expected one config file, found ${configs.join(", ")}`);
  const starter = JSON.parse(await readFile(config, "utf8")) as {
    repositories: unknown[];
  };
  starter.repositories = [{ id: "self", path: repoRoot }];
  await writeFile(config, JSON.stringify(starter, null, 2));
  console.log(gitFlowerGarden(["validate-config"]).trim());

  step("serve with the default cache");
  await withServer(["serve", "--port", "0"], async (url) => {
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

  step("demo, twice (a killed demo's folder is swept by the next)");
  for (let round = 0; round < 2; round++) {
    await withServer(["demo", "--port", "0"], async (url) => {
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
  const demoLeft = (await readdir(join(home, "tmp"))).filter((n) =>
    n.startsWith("git-flower-garden-demo-"),
  );
  // Ctrl+C removes it; a killed demo (Windows here) leaves one, never more.
  if (demoLeft.length > (windows ? 1 : 0))
    throw new Error(`demo folders left behind: ${demoLeft.join(", ")}`);
  console.log(`demo folders left in temp: ${String(demoLeft.length)}`);

  step("update to a newer version");
  const configBefore = await sha(config);
  const next = join(work, "next");
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
      [npmCli, "pack", "--json", "--pack-destination", work],
      { cwd: next, env, encoding: "utf8" },
    ),
  ) as { filename: string }[];
  npm(["install", "--global", join(work, packed[0]?.filename ?? "")]);
  const updated = gitFlowerGarden(["--version"]).trim();
  console.log(updated);
  if (updated !== `git-flower-garden ${nextVersion}`)
    throw new Error(`update did not take: ${updated}`);
  if ((await sha(config)) !== configBefore)
    throw new Error("the update changed the configuration file");
  console.log("configuration kept");

  step("remove cached data, then uninstall");
  console.log(gitFlowerGarden(["cache", "--clean-all"]).trim());
  npm(["uninstall", "--global", staged.name]);
  const leftInPrefix = await listed(prefix);
  if (leftInPrefix.length > 0)
    throw new Error(`left in the npm prefix:\n${leftInPrefix.join("\n")}`);
  console.log("npm prefix: no files left");

  step("what remains in the home folder");
  const leftInHome = (await listed(home)).filter(
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

  console.log(
    "\nRelease rehearsal passed: install, use, update, and uninstall; only the configuration file remains.",
  );
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
