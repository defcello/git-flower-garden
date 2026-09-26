/*
 * Write a demo fixture repository to disk for manual inspection:
 *
 *   npm run fixture -- <name> [directory]
 *
 * The directory defaults to tmp/fixtures/<name> and must be empty or absent.
 */
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFixture } from "../../src/demo/builder.ts";
import { demoFixtures, type DemoFixtureName } from "../../src/demo/fixtures.ts";

const [name, directory] = process.argv.slice(2);
const names = Object.keys(demoFixtures);

if (name === undefined || !(name in demoFixtures)) {
  console.error(`Usage: npm run fixture -- <${names.join("|")}> [directory]`);
  process.exit(2);
}

const spec = demoFixtures[name as DemoFixtureName];
const dir = resolve(directory ?? `tmp/fixtures/${name}`);
await mkdir(dir, { recursive: true });
if ((await readdir(dir)).length > 0) {
  console.error(`Refusing to write into non-empty directory: ${dir}`);
  process.exit(1);
}

const fixture = await buildFixture(spec, dir);
console.log(`${spec.description}\n\nCreated ${dir}`);
for (const [commit, oid] of fixture.oids) console.log(`  ${oid}  ${commit}`);
