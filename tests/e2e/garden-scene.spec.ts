/*
 * The hillside layout under the section 7 contract: technical stays the
 * default, the unattended garden scene carries no text (names and status on
 * hover, focus, or tap, by maintainer design), empty and broken repositories
 * stay visible through soil beds and marker stakes, focus controls keep a
 * 44 px target after scaling, and the viewer's renderer choice is
 * remembered. Uses its own small garden (the shared fixture server has more
 * repositories than the hillside holds).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture, fixtureGit } from "../../src/demo/builder.ts";
import { artProof, forkMerge } from "../../src/demo/fixtures.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";

let app: RunningApp;
let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "git-garden-scene-"));
  await buildFixture(artProof, join(root, "tour"));
  await buildFixture(forkMerge, join(root, "fork"));
  await mkdir(join(root, "empty"));
  await fixtureGit(root, ["init", "--quiet", join(root, "empty")]);
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: [
        { id: "tour", label: "Garden tour", path: "tour" },
        { id: "fork", label: "Fork and merge", path: "fork" },
        { id: "empty", label: "Empty repository", path: "empty" },
        { id: "missing", label: "Missing path", path: "nowhere" },
      ],
    }),
    root,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  app = await startApp(parsed.config, {
    now: () => Date.parse("2026-09-22T15:00:00-04:00"),
    port: 0,
    cacheRoot: join(root, ".cache"),
  });
});

test.afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test("technical is the default; the garden choice is remembered", async ({
  page,
}) => {
  await page.goto(app.url);
  await expect(page.getByLabel("Renderer", { exact: true })).toHaveValue(
    "technical",
  );
  await expect(page.locator(".garden-scene")).toHaveCount(0);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator(".garden-scene")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Renderer", { exact: true })).toHaveValue(
    "canvas",
  );
  await expect(page.locator(".garden-scene")).toHaveCount(1);
});

test("the unattended scene has no text; hover and focus reveal each plant's name and state", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.mouse.move(2, 2);
  // By maintainer design, the overview in the garden renderer is a natural
  // scene: no always-visible names, status lines, or placeholder text.
  for (const id of ["tour", "fork", "empty", "missing"]) {
    const plot = page.locator(`[data-plot="${id}"]`);
    await expect(plot.locator("h2"), id).toHaveCSS("opacity", "0");
    await expect(plot.locator(".status"), id).toHaveCSS("opacity", "0");
  }
  for (const id of ["empty", "missing"]) {
    await expect(
      page.locator(`[data-plot="${id}"] .placeholder`),
      id,
    ).toHaveCSS("opacity", "0");
  }
  // Hover reveals the name and state.
  const missing = page.locator('[data-plot="missing"]');
  await missing.hover();
  await expect(missing.locator("h2")).toHaveCSS("opacity", "1");
  await expect(missing.locator(".status")).toContainText("Error");
  await expect(missing.locator(".status")).toContainText("Path not found");
  // The whole name is readable, not cut to a letter by the card layout.
  const name = missing.locator("h2");
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  // The cards sit beside the circular +, never over it.
  for (const id of ["missing", "tour"]) {
    const plot = page.locator(`[data-plot="${id}"]`);
    await plot.hover();
    await expect(plot.locator("h2")).toHaveCSS("opacity", "1");
    const button = plot.locator(".focus-button");
    const box = await button.boundingBox();
    if (!box) throw new Error(`no focus button for ${id}`);
    const hit = await button.evaluate(
      (el, [x, y]) => el.contains(document.elementFromPoint(x ?? 0, y ?? 0)),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, id).toBe(true);
  }
  await missing.hover();
  // One card: the placeholder text stays for assistive technology only.
  await expect(missing.locator(".placeholder")).toHaveCSS("opacity", "0");
  await expect(missing.locator(".placeholder")).toHaveText(/could not be read/);
  const empty = page.locator('[data-plot="empty"]');
  await empty.hover();
  await expect(empty.locator(".status")).toContainText("no commits yet");
  // So does keyboard focus.
  await page.mouse.move(2, 2);
  const tour = page.locator('[data-plot="tour"]');
  await tour.focus();
  await expect(tour.locator("h2")).toHaveCSS("opacity", "1");
  await expect(tour.locator(".status")).toContainText("Up to date");
});

test("empty and broken repositories stay visible without text", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.mouse.move(2, 2);
  // Healthy plants carry no marker at all.
  for (const id of ["tour", "fork"]) {
    await expect(
      page.locator(`[data-plot="${id}"] .plant-marker`),
      id,
    ).toHaveCount(0);
  }
  // An empty repository is a bare soil bed, with no warning stake.
  const empty = page.locator('[data-plot="empty"]');
  await expect(empty.locator(".plant-bed")).toBeVisible();
  await expect(empty.locator(".stake-tag")).toHaveCount(0);
  // An unreadable one is a soil bed with a marker stake showing its state.
  const missing = page.locator('[data-plot="missing"]');
  await expect(missing.locator(".plant-bed")).toBeVisible();
  await expect(missing.locator(".stake-tag")).toBeVisible();
  await expect(missing.locator(".stake-tag")).toHaveText("✕");
  const tag = await missing
    .locator(".stake-tag")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(tag).toBeGreaterThanOrEqual(10);
  // The technical renderer keeps names and status always visible.
  await page.getByLabel("Renderer", { exact: true }).selectOption("technical");
  await page.mouse.move(2, 2);
  await expect(page.locator(".plant-marker")).toHaveCount(0);
  await expect(missing.locator("h2")).toBeVisible();
  await expect(missing.locator("h2")).toHaveCSS("opacity", "1");
  await expect(missing.locator(".status")).toContainText("Error");
});

test("focus controls keep a 44 px target after plant scaling", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  for (const id of ["tour", "fork", "empty", "missing"]) {
    const plot = page.locator(`[data-plot="${id}"]`);
    await plot.focus();
    const box = await plot.locator(".focus-button").boundingBox();
    expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(43.5);
    expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(43.5);
  }
  await page.locator('[data-plot="tour"]').focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Show all repositories" }),
  ).toBeFocused();
});
