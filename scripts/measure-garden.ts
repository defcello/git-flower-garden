/*
 * CPU use of a visible Chromium window showing the garden (ADR 0018,
 * "Verification"): the demo fixtures planted N times on the hillside, the
 * Canvas compositor, the noon preview, 1920×1080, for each drawing tier.
 * Reads every browser process's CPU time from /proc (Linux only) over 20
 * seconds and prints it by process type, in percent of one core, with
 * the tier that actually drew. With LOOP=1 the day loops (a day every 30
 * seconds) and it also counts how often the scene repainted.
 *
 *   npm run measure:garden               # 8 plants, Software then Static
 *   N=64 TIERS=software npm run measure:garden
 *   LOOP=1 TIERS=gpu,software npm run measure:garden  # while the day loops
 *   WEATHER=heavy-rain TIERS=gpu,software npm run measure:garden
 *   GARDEN_E2E_CHANNEL=chrome npm run measure:garden
 *
 * Needs a display: the point is the real GPU path, which headless skips.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { parseConfig } from "../src/config/config.ts";
import { buildFixture } from "../src/demo/builder.ts";
import {
  artProof,
  crissCross,
  forkMerge,
  threeHeads,
} from "../src/demo/fixtures.ts";
import { startApp } from "../src/server/app.ts";

const plants = Number(process.env.N ?? 8);
const tiers = (process.env.TIERS ?? "software,static").split(",");
const SECONDS = 20;
const loop = process.env.LOOP === "1";
/** A weather preview to draw (weather-previews.ts), or none. */
const weather = process.env.WEATHER ?? null;
/** Kernel clock ticks per second (USER_HZ), as /proc reports CPU time. */
const HZ = 100;

const root = await mkdtemp(join(tmpdir(), "git-flower-garden-measure-"));
const fixtures = {
  tour: artProof,
  fork: forkMerge,
  three: threeHeads,
  criss: crissCross,
};
for (const [name, fixture] of Object.entries(fixtures))
  await buildFixture(fixture, join(root, name));
const names = Object.keys(fixtures);
const parsed = parseConfig(
  JSON.stringify({
    version: 1,
    history: { timeZone: "America/New_York" },
    repositories: Array.from({ length: plants }, (_, i) => ({
      id: `r${String(i)}`,
      label: `Repository ${String(i)}`,
      path: names[i % names.length] ?? "tour",
    })),
  }),
  root,
);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
const app = await startApp(parsed.config, {
  now: () => Date.now(),
  port: 0,
  cacheRoot: join(root, ".cache"),
});

/** Fields of /proc/<pid>/stat after the command name. */
async function stat(pid: number | string): Promise<string[]> {
  const text = await readFile(`/proc/${String(pid)}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ");
}

/** A process and all its descendants. */
async function family(ancestor: number): Promise<number[]> {
  const parents = new Map<number, number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      parents.set(Number(entry), Number((await stat(entry))[1]));
    } catch {
      // The process ended while listing.
    }
  }
  const members = new Set([ancestor]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents)
      if (members.has(parent) && !members.has(pid)) {
        members.add(pid);
        grew = true;
      }
  }
  return [...members];
}

/** CPU ticks so far (user and system), by Chromium process type. */
async function ticks(pids: number[]): Promise<Record<string, number>> {
  const byType: Record<string, number> = {};
  for (const pid of pids) {
    try {
      const fields = await stat(pid);
      const cmdline = await readFile(`/proc/${String(pid)}/cmdline`, "utf8");
      const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? "browser";
      byType[type] =
        (byType[type] ?? 0) + Number(fields[11]) + Number(fields[12]);
    } catch {
      // The process ended.
    }
  }
  return byType;
}

const server = await chromium.launchServer({
  headless: false,
  channel: process.env.GARDEN_E2E_CHANNEL ?? "chromium",
});
try {
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.getByLabel("Sky", { exact: true }).selectOption("noon");
  if (weather !== null)
    await page.getByLabel("Weather", { exact: true }).selectOption(weather);
  if (loop) await page.getByLabel("Loop", { exact: true }).check();
  console.log(
    `GPU: ${(await page.locator("html").getAttribute("data-gpu")) ?? "not probed"}`,
  );
  for (const tier of tiers) {
    await page.getByLabel("Drawing", { exact: true }).selectOption(tier);
    await page.mouse.move(2, 2);
    // Let relighting and caches settle.
    await page.waitForTimeout(6000);
    const pids = await family(server.process().pid ?? 0);
    // Count repaints of the scene: each changes the light it shows.
    // (A string: this script is compiled without the DOM's types.)
    await page.evaluate(`
      window.repaints = 0;
      window.repaintObserver?.disconnect();
      window.repaintObserver = new MutationObserver((changes) => {
        window.repaints += changes.length;
      });
      window.repaintObserver.observe(document.querySelector(".landscape") ?? document.body, {
        subtree: true,
        attributeFilter: ["data-sky-light"],
      });
    `);
    const before = await ticks(pids);
    await page.waitForTimeout(SECONDS * 1000);
    const after = await ticks(pids);
    const repaints = Number(await page.evaluate("window.repaints"));
    const drawn =
      (await page.locator(".landscape-scene").getAttribute("data-tier")) ?? "?";
    const probe =
      (await page.locator("html").getAttribute("data-gpu-probe")) ?? "none";
    const percent = Object.fromEntries(
      Object.entries(after).map(([type, t]) => [
        type,
        Math.round(((t - (before[type] ?? 0)) / HZ / SECONDS) * 100),
      ]),
    );
    const total = Object.values(percent).reduce((a, b) => a + b, 0);
    const sway = (await page.locator("html").getAttribute("data-sway")) ?? "on";
    const particles =
      (await page
        .locator(".weather-fall")
        .getAttribute("data-particles", {
          timeout: 1000,
        })
        .catch(() => null)) ?? "0";
    console.log(
      `${String(plants)} plants, ${weather ?? "no weather"} (${particles} particles), ${tier} (drawn by ${drawn}): ${String(total)}% of one core ${JSON.stringify(percent)}; sway ${sway}; GPU probe ${probe}` +
        (loop
          ? `; ${(repaints / SECONDS).toFixed(1)} scene repaints a second`
          : ""),
    );
  }
  await browser.close();
} finally {
  await server.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
