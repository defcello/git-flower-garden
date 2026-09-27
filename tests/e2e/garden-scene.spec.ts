/*
 * The hillside layout under the section 7 contract: technical stays the
 * default, every plant shows its name and state (including empty and broken
 * repositories), focus controls keep a 44 px target after scaling, and the
 * viewer's renderer choice is remembered. Uses its own small garden (the
 * shared fixture server has more repositories than the hillside holds).
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

test("every plant shows its name and state, including empty and broken repositories", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.mouse.move(2, 2);
  const labels = page.locator(".plant-label");
  await expect(labels).toHaveCount(4);
  for (const [name, state] of [
    ["Garden tour", "Up to date"],
    ["Fork and merge", "Up to date"],
    ["Empty repository", "Up to date"],
    ["Missing path", "Error"],
  ] as const) {
    const label = labels.filter({ hasText: name });
    await expect(label).toBeVisible();
    await expect(label).toContainText(state);
    // Readable at any plant scale.
    const size = await label
      .locator(".plant-name")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(size).toBeGreaterThanOrEqual(12);
  }
  await expect(page.locator('[data-plot="empty"] .placeholder')).toBeVisible();
  await expect(
    page.locator('[data-plot="missing"] .placeholder'),
  ).toBeVisible();
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
