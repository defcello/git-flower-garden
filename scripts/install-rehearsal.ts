/*
 * Clean-install rehearsal (roadmap P1-E): pack the built project, install the
 * tarball into an empty directory, and use the installed CLI as a new user
 * would: version, init-config, validate-config, serve, and demo.
 *
 *   npm run build && npm run rehearse:install
 *
 * Runs in CI on Windows, macOS, and Linux.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
// Run npm's own JavaScript entry point with Node (set by `npm run`), so no
// shell is involved on Windows, where npm is a .cmd script.
const npmCli = process.env.npm_execpath;
if (!npmCli?.endsWith(".js")) {
  throw new Error("Run this through npm: npm run rehearse:install");
}
const npm = (args: string[], cwd: string) =>
  run(process.execPath, [npmCli, ...args], cwd);
const step = (text: string) => {
  console.log(`\n== ${text}`);
};

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

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

/** Start the installed CLI, wait for its URL, run checks, then stop it. */
async function withServer(
  cli: string,
  args: string[],
  cwd: string,
  check: (url: string) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
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
    child.kill();
  }
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const work = await mkdtemp(join(tmpdir(), "git-garden-install-"));
try {
  step("npm pack");
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", work], repoRoot),
  ) as {
    filename: string;
    files: { path: string }[];
  }[];
  const tarball = join(work, (packed[0] as { filename: string }).filename);
  const files = (packed[0] as { files: { path: string }[] }).files.map(
    (f) => f.path,
  );
  console.log(`${String(files.length)} files in ${tarball}`);
  for (const required of [
    "dist/cli.js",
    "dist/ui/index.html",
    "git-garden.schema.json",
    "LICENSE",
  ]) {
    if (!files.includes(required))
      throw new Error(`package is missing ${required}`);
  }
  if (files.some((f) => f.startsWith("tests/") || f.startsWith("src/"))) {
    throw new Error("package unexpectedly contains sources or tests");
  }

  step("install into an empty project");
  const app = join(work, "app");
  run(
    process.execPath,
    ["-e", `require("fs").mkdirSync(${JSON.stringify(app)})`],
    work,
  );
  await writeFile(
    join(app, "package.json"),
    '{ "name": "rehearsal", "private": true }\n',
  );
  npm(["install", "--no-audit", "--no-fund", tarball], app);
  const cli = join(app, "node_modules", "git-garden", "dist", "cli.js");
  const shim = join(
    app,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "git-garden.cmd" : "git-garden",
  );
  if (!existsSync(shim)) throw new Error(`bin shim missing: ${shim}`);
  const installed = JSON.parse(
    await readFile(
      join(app, "node_modules", "git-garden", "package.json"),
      "utf8",
    ),
  ) as { version: string };

  step("--version");
  const versionOut = run(process.execPath, [cli, "--version"], app).trim();
  console.log(versionOut);
  if (versionOut !== `git-garden ${installed.version}`)
    throw new Error(`unexpected version output: ${versionOut}`);
  if (process.platform !== "win32") {
    // The installed command is a symlink to dist/cli.js, run via its shebang.
    const viaShim = run(shim, ["--version"], app).trim();
    console.log(`${viaShim} (via the installed symlink)`);
    if (viaShim !== versionOut)
      throw new Error(`the installed command printed: ${viaShim}`);
  }

  step("init-config and validate-config against a real repository");
  const config = join(work, "config.json");
  run(process.execPath, [cli, "init-config", "--config", config], app);
  const text = JSON.parse(await readFile(config, "utf8")) as {
    repositories: unknown[];
  };
  text.repositories = [{ id: "self", path: repoRoot }];
  await writeFile(config, JSON.stringify(text, null, 2));
  console.log(
    run(
      process.execPath,
      [cli, "validate-config", "--config", config],
      app,
    ).trim(),
  );

  step("serve");
  await withServer(
    cli,
    [
      "serve",
      "--config",
      config,
      "--port",
      "0",
      "--cache-dir",
      join(work, "cache"),
    ],
    app,
    async (url) => {
      const health = await get(`${url}api/health`);
      if (health.status !== 200)
        throw new Error(`health: ${String(health.status)}`);
      const page = await get(url);
      if (!page.body.includes('<div id="root">'))
        throw new Error("UI index.html not served");
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
      if (!script || (await get(new URL(script, url).href)).status !== 200)
        throw new Error("UI script not served");
      await waitFor("repository ready", async () =>
        // CI checkouts are shallow, which is reported honestly as "incomplete".
        /"state":"(ready|incomplete)"/.test(
          (await get(`${url}api/repositories`)).body,
        ),
      );
      console.log(`served ${url}: health ok, UI ok, repository ready`);
    },
  );

  step("demo");
  await withServer(cli, ["demo", "--port", "0"], app, async (url) => {
    await waitFor("five demo repositories", async () => {
      const body = JSON.parse((await get(`${url}api/repositories`)).body) as {
        repositories: { status: { state: string } }[];
      };
      return (
        body.repositories.length === 5 &&
        body.repositories.every((r) => r.status.state === "ready")
      );
    });
    console.log(`demo ${url}: five repositories ready`);
  });

  console.log("\nInstall rehearsal passed.");
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
}
