/*
 * Stage the end-user release package: the finished program only.
 *
 *   npm run release:stage
 *
 * Writes release/stage/ and packs it to release/<name>-<version>.tgz. The
 * staged package has compiled JavaScript without source maps, declarations,
 * or comments; the built browser UI; an end-user README and user guide; the
 * configuration schema and example; and a package.json with no scripts or
 * development dependencies. It runs no install scripts. The script refuses to
 * pack if anything that reads as a development checkout slips in.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
// npm's own JavaScript entry point, run with Node (no shell on Windows).
const npmCli = process.env.npm_execpath;
if (!npmCli?.endsWith(".js"))
  throw new Error("Run this through npm: npm run release:stage");
const releaseDir = join(repoRoot, "release");
const stage = join(releaseDir, "stage");

const source = JSON.parse(
  await readFile(join(repoRoot, "package.json"), "utf8"),
) as {
  version: string;
  description: string;
  license: string;
  keywords: string[];
  engines: Record<string, string>;
  bin: Record<string, string>;
  type: string;
  name: string;
  author: string;
  homepage: string;
  bugs: { url: string };
  repository: { type: string; url: string };
};
// The package name comes from package.json; the command is always git-flower-garden.
const PACKAGE_NAME = source.name;
/** npm's tarball name for a (possibly scoped) package. */
const TARBALL = `${PACKAGE_NAME.replace(/^@/, "").replace("/", "-")}-${source.version}.tgz`;
/** Releases are GitHub release files, not npm registry packages (for now). */
const REPOSITORY = source.repository.url
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(REPOSITORY))
  throw new Error(`Not a GitHub repository URL: ${REPOSITORY}`);
const DOWNLOAD = `${REPOSITORY}/releases/download/v${source.version}/${TARBALL}`;

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

await rm(stage, { recursive: true, force: true });
// Only this version's tarball is left to release.
for (const old of await readdir(releaseDir).catch(() => []))
  if (old.endsWith(".tgz")) await rm(join(releaseDir, old));
await mkdir(stage, { recursive: true });

// Server and CLI: the release build (no maps, declarations, or comments).
run(
  process.execPath,
  [
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.release.json",
    "--outDir",
    join(stage, "dist"),
  ],
  repoRoot,
);
// Browser UI: the production bundle from `npm run build`. The artwork's
// provenance record stays in the repository; the LICENSE covers the art.
await cp(join(repoRoot, "dist", "ui"), join(stage, "dist", "ui"), {
  recursive: true,
});
await rm(join(stage, "dist", "ui", "asset-manifest.json"), { force: true });
for (const [from, to] of [
  ["docs/package-readme.md", "README.md"],
  ["docs/user-guide.md", "docs/user-guide.md"],
  ["LICENSE", "LICENSE"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["git-flower-garden.schema.json", "git-flower-garden.schema.json"],
  ["git-flower-garden.example.json", "git-flower-garden.example.json"],
] as const) {
  await mkdir(join(stage, to, ".."), { recursive: true });
  await cp(join(repoRoot, from), join(stage, to));
}
// The UI bundle keeps no license comments, so the notices of the
// third-party code it contains ship beside it (ADR 0019, condition 3).
const THIRD_PARTY = [
  ["astronomy-engine (vendored, ADR 0019)", "vendor/astronomy-engine/LICENSE"],
  ["react", "node_modules/react/LICENSE"],
  ["react-dom", "node_modules/react-dom/LICENSE"],
  ["scheduler (used by react-dom)", "node_modules/scheduler/LICENSE"],
] as const;
const notices = [
  "# Third-party notices\n",
  "The browser interface in `dist/ui` includes the following software.\n",
];
for (const [name, file] of THIRD_PARTY) {
  const text = (await readFile(join(repoRoot, file), "utf8")).trim();
  if (!/^MIT License/.test(text) || !/Copyright/.test(text))
    throw new Error(`${file}: not the expected MIT notice`);
  notices.push(`## ${name}\n\n\`\`\`text\n${text}\n\`\`\`\n`);
}
await writeFile(join(stage, "THIRD-PARTY-NOTICES.md"), notices.join("\n"));

const readme = join(stage, "README.md");
await writeFile(
  readme,
  (await readFile(readme, "utf8"))
    .replaceAll("{{PACKAGE}}", PACKAGE_NAME)
    .replaceAll("{{INSTALL}}", DOWNLOAD)
    .replaceAll("{{RELEASES}}", `${REPOSITORY}/releases`)
    .replaceAll("{{REPOSITORY}}", REPOSITORY)
    .replaceAll("{{VERSION}}", source.version),
);

const manifest = {
  name: PACKAGE_NAME,
  version: source.version,
  description: source.description,
  license: source.license,
  keywords: source.keywords,
  type: source.type,
  bin: source.bin,
  engines: source.engines,
  author: source.author,
  homepage: source.homepage,
  bugs: source.bugs,
  repository: source.repository,
  // Distributed as GitHub release files; this guards against an accidental
  // npm publish until publishing there is decided. Global installs work.
  private: true,
  files: [
    "dist/",
    "docs/",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "CHANGELOG.md",
    "git-flower-garden.schema.json",
    "git-flower-garden.example.json",
  ],
};
await writeFile(
  join(stage, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// Refuse anything that reads as a development checkout.
const problems: string[] = [];
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const leaks = [
  /sourceMappingURL/,
  /[A-Za-z]:\\\\?Users\\\\?/,
  /\/(Users|home)\/[^/\s"']+\//,
  /\b(vitest|playwright|eslint|prettier)\b/i,
  /\btests?\/[\w-]+\.test\./,
  /\broadmap\b/i,
  /\bP\d-[A-F]\b/,
];
for (const file of await files(stage)) {
  const name = relative(stage, file).split(sep).join("/");
  if (/\.(map|ts|tsx)$/.test(name) && !name.endsWith(".d.ts"))
    problems.push(`${name}: source or map file`);
  if (name.endsWith(".d.ts")) problems.push(`${name}: type declarations`);
  if (!name.startsWith("dist/")) continue;
  if (!/\.(js|html|css|json)$/.test(name)) continue;
  const text = await readFile(file, "utf8");
  for (const pattern of leaks)
    if (pattern.test(text))
      problems.push(`${name}: matches ${String(pattern)}`);
  if (home && text.includes(home)) problems.push(`${name}: contains ${home}`);
  if (text.includes(repoRoot))
    problems.push(`${name}: contains the checkout path`);
}
// The docs must show how users actually install and remove this package.
const readmeText = await readFile(join(stage, "README.md"), "utf8");
if (!readmeText.includes(`npm install --global ${DOWNLOAD}`))
  problems.push("README.md: does not show this release's install command");
for (const doc of ["README.md", "docs/user-guide.md"]) {
  const text = await readFile(join(stage, doc), "utf8");
  if (!text.includes(`npm uninstall --global ${PACKAGE_NAME}`))
    problems.push(`${doc}: does not show the uninstall command`);
  if (/{{[A-Z]+}}/.test(text))
    problems.push(`${doc}: has an unfilled placeholder`);
  // Unscoped names: `git-garden` (the former name) is an unrelated package.
  if (/npm (un)?install --global git-(flower-)?garden(?!-)/.test(text))
    problems.push(`${doc}: names an unscoped npm package, not ${PACKAGE_NAME}`);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  throw new Error("The staged package contains development material.");
}

const packed = JSON.parse(
  run(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", releaseDir],
    stage,
  ),
) as { filename: string; entryCount: number; size: number }[];
const result = packed[0];
if (!result) throw new Error("npm pack produced nothing");
if (result.filename !== TARBALL)
  throw new Error(
    `npm named the package ${result.filename}; the docs link ${TARBALL}`,
  );
const tarball = join(releaseDir, result.filename);
const sha256 = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
console.log(
  `${relative(repoRoot, tarball)}: ${String(result.entryCount)} files, ${String(Math.round(result.size / 1024))} KiB, sha256 ${sha256}`,
);
