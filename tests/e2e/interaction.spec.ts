/*
 * Browser tests for roadmap section 7 (P1-C exit): garden and focus views,
 * the circular +/- controls, hover tooltips and pinned details, keyboard use,
 * pan and zoom, camera restoration, and stable selection across live updates.
 * Runs against tests/e2e/fixture-server.ts (real Git repositories, pinned clock).
 */
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIXTURE_ENV } from "../../src/demo/builder.ts";
import { runGit } from "../../src/git/run-git.ts";

const root = process.env.GARDEN_E2E_ROOT as string;

async function openGarden(page: Page): Promise<void> {
  await page.goto("/");
  // Every readable repository has drawn its graph.
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7, {
    timeout: 20_000,
  });
}

const plot = (page: Page, label: string): Locator =>
  page.locator("section.plot", {
    has: page.getByRole("heading", { name: label, exact: true }),
  });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

async function camera(page: Page) {
  const el = page.locator(".focus-graph");
  return {
    scale: Number(await el.getAttribute("data-scale")),
    x: Number(await el.getAttribute("data-x")),
    y: Number(await el.getAttribute("data-y")),
  };
}

test.describe("garden view", () => {
  test("shows every repository in configuration order with a readable status", async ({
    page,
  }) => {
    await openGarden(page);
    await expect(page.locator("section.plot h2")).toHaveText([
      "Garden tour",
      "Fork and merge",
      "Criss-cross",
      "Empty repository",
      "Missing path",
      "Extra 0",
      "Extra 1",
      "Extra 2",
      "Extra 3",
    ]);
    await expect(plot(page, "Garden tour").locator(".status")).toContainText(
      "Up to date",
    );
    await expect(plot(page, "Garden tour").locator(".status")).toContainText(
      "10 of 16 commits shown",
    );
    await expect(plot(page, "Empty repository")).toContainText(
      "No commits yet",
    );
    // Status is conveyed in words, not only color.
    await expect(plot(page, "Missing path").locator(".status")).toContainText(
      "Error",
    );
    await expect(
      plot(page, "Missing path").locator(".diagnostic"),
    ).toContainText("Path not found");
  });

  test("hovering a plot reveals a 44px circular + centered above its tree, which stays while moving onto it", async ({
    page,
  }) => {
    await openGarden(page);
    const tour = plot(page, "Garden tour");
    const plus = tour.getByRole("button", { name: "Focus Garden tour" });
    await page.mouse.move(5, 5);
    await expect(plus).toHaveCSS("opacity", "0");
    await tour.locator("svg.graph").hover();
    await expect(plus).toHaveCSS("opacity", "1");

    const b = await box(plus);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(await plus.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(
      "50%",
    );
    // Above the tree, centered over its lanes (not over the text column).
    const nodes = tour.locator("g.commit circle.node, g.commit path.node");
    const firstNode = await box(nodes.first());
    expect(b.y + b.height).toBeLessThanOrEqual(firstNode.y);
    const lanes = await tour
      .locator("g.commit")
      .evaluateAll((els) =>
        els.map((g) =>
          (
            g.querySelector(".node") as SVGGraphicsElement
          ).getBoundingClientRect(),
        ),
      );
    const minX = Math.min(...lanes.map((r) => r.left));
    const maxX = Math.max(...lanes.map((r) => r.right));
    expect(Math.abs(b.x + b.width / 2 - (minX + maxX) / 2)).toBeLessThan(24);

    // Move from the tree to the button: it must remain visible and clickable.
    await page.mouse.move(firstNode.x + 4, firstNode.y + 4);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await expect(plus).toHaveCSS("opacity", "1");
    await plus.click();
    await expect(
      page.getByRole("button", { name: "Show all repositories" }),
    ).toBeVisible();
    await expect(
      page.getByRole("main", { name: "Garden tour, focused" }),
    ).toBeVisible();
  });

  test("hover shows a tooltip; click pins details without zooming", async ({
    page,
  }) => {
    await openGarden(page);
    const tour = plot(page, "Garden tour");
    const merge = tour.locator("g.commit", {
      hasText: "Merge branch 'trellis'",
    });
    await merge.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Merge branch 'trellis'",
    );
    await expect(page.getByRole("tooltip")).toContainText("tag: v1.0");
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await merge.click();
    const details = page.getByRole("complementary", { name: "Commit details" });
    await expect(
      details.getByRole("heading", { name: "Merge branch 'trellis'" }),
    ).toBeVisible();
    await expect(details).toContainText("v1.0");
    await expect(details).toContainText("Fern Example <fern@example.invalid>");
    await expect(details.locator(".oid-full")).toHaveText(/^[0-9a-f]{40}$/);
    await expect(details).toContainText("Parents (2, in order)");
    // Still the garden; nothing zoomed or scrolled.
    await expect(
      page.getByRole("main", { name: "All repositories" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  });

  test("several refs on one commit are all discoverable", async ({ page }) => {
    await openGarden(page);
    await plot(page, "Fork and merge")
      .locator("g.commit", { hasText: "main, release" })
      .click();
    const details = page.getByRole("complementary", { name: "Commit details" });
    await expect(details.locator(".chips li")).toHaveText(["main", "release"]);
    await expect(details).toContainText("Worktrees");
  });
});

test.describe("focus view", () => {
  test("keyboard: focus a plot, open it, use the commit list, and Escape back out", async ({
    page,
  }) => {
    await openGarden(page);
    // Scroll to a lower plot so restoration is observable.
    const target = plot(page, "Extra 2");
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    await expect(
      target.getByRole("button", { name: "Focus Extra 2" }),
    ).toHaveCSS("opacity", "1");
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(200);

    await page.keyboard.press("Tab");
    await expect(
      target.getByRole("button", { name: "Focus Extra 2" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const minus = page.getByRole("button", { name: "Show all repositories" });
    await expect(minus).toBeFocused();

    // Reach the commit list by keyboard and open details.
    const first = page
      .getByRole("navigation", { name: "Commits in Extra 2, newest first" })
      .getByRole("button")
      .first();
    await first.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: "Commit details" });
    await expect(details.getByRole("heading", { level: 2 })).toBeFocused();

    // Escape closes details first, then restores the garden camera and focus.
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(
      page.getByRole("main", { name: "Extra 2, focused" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("main", { name: "All repositories" }),
    ).toBeVisible();
    await expect(target).toBeFocused();
    expect(
      Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore),
    ).toBeLessThanOrEqual(2);
  });

  test("the − button replaces + in the same place above the tree and restores the garden", async ({
    page,
  }) => {
    await openGarden(page);
    const tour = plot(page, "Garden tour");
    await tour.hover();
    await tour.getByRole("button", { name: "Focus Garden tour" }).click();
    const minus = page.getByRole("button", { name: "Show all repositories" });
    const m = await box(minus);
    expect(m.width).toBeGreaterThanOrEqual(44);
    const nodes = await page
      .locator(".focus-graph g.commit .node")
      .evaluateAll((els) =>
        els.map((el) => (el as SVGGraphicsElement).getBoundingClientRect()),
      );
    const top = Math.min(...nodes.map((r) => r.top));
    const center =
      (Math.min(...nodes.map((r) => r.left)) +
        Math.max(...nodes.map((r) => r.right))) /
      2;
    expect(m.y + m.height).toBeLessThanOrEqual(top);
    expect(Math.abs(m.x + m.width / 2 - center)).toBeLessThan(30);
    await minus.click();
    await expect(
      page.getByRole("main", { name: "All repositories" }),
    ).toBeVisible();
    await expect(tour).toBeFocused();
  });

  test("bounded pan and zoom; selecting a commit keeps the camera; Fit reframes", async ({
    page,
  }) => {
    // Many real pointer and wheel events: slow on low-end CI machines.
    test.setTimeout(60_000);
    await openGarden(page);
    await plot(page, "Garden tour").focus();
    await page.keyboard.press("Enter");
    const graph = page.locator(".focus-graph");
    await expect(graph).toBeVisible();
    const start = await camera(page);
    const g = await box(graph);

    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.wheel(0, -300);
    await expect
      .poll(async () => (await camera(page)).scale)
      .toBeGreaterThan(start.scale);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await camera(page)).scale).toBe(4);

    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await expect.poll(async () => (await camera(page)).scale).toBe(start.scale);

    // Drag pans, and releasing over a commit does not select it.
    const before = await camera(page);
    await page.mouse.move(g.x + 40, g.y + g.height - 40);
    await page.mouse.down();
    await page.mouse.move(g.x + 240, g.y + g.height - 140, { steps: 10 });
    await page.mouse.up();
    const after = await camera(page);
    expect(after.x - before.x).toBeCloseTo(200, 0);
    await expect(
      page.getByRole("complementary", { name: "Commit details" }),
    ).toBeHidden();

    // Dragging far away stays bounded: part of the drawing remains visible.
    await page.mouse.move(g.x + 100, g.y + 100);
    await page.mouse.down();
    await page.mouse.move(g.x + 5000, g.y + 5000, { steps: 5 });
    await page.mouse.up();
    const far = await camera(page);
    expect(far.x).toBeLessThanOrEqual(g.width - 80 + 0.5);
    expect(far.y).toBeLessThanOrEqual(g.height - 80 + 0.5);

    // Clicking a commit pins details and leaves the camera alone.
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const framed = await camera(page);
    await page
      .locator(".focus-graph g.commit", { hasText: "Build the trellis" })
      .click();
    await expect(
      page.getByRole("complementary", { name: "Commit details" }),
    ).toBeVisible();
    expect(await camera(page)).toEqual(framed);
  });
});

test.describe("live updates (these change fixture repositories, so they run last)", () => {
  async function commitAt(
    dir: string,
    message: string,
    iso: string,
  ): Promise<void> {
    const date = `${String(Math.floor(Date.parse(iso) / 1000))} -0400`;
    await runGit(["commit", "--quiet", "--allow-empty", "-m", message], {
      cwd: dir,
      env: { ...FIXTURE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }

  test("new commits appear without reload and the pinned selection stays put", async ({
    page,
  }) => {
    await openGarden(page);
    const extra = plot(page, "Extra 0");
    await extra
      .locator("g.commit", { hasText: "Merge branch 'trellis'" })
      .click();
    const details = page.getByRole("complementary", { name: "Commit details" });
    await expect(
      details.getByRole("heading", { name: "Merge branch 'trellis'" }),
    ).toBeVisible();

    await commitAt(
      join(root, "extra-0"),
      "Plant a new hedge",
      "2026-09-22T14:00:00-04:00",
    );
    await expect(
      extra.locator("g.commit", { hasText: "Plant a new hedge" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      extra.locator("g.commit", { hasText: "Plant a new hedge" }),
    ).toContainText("main");
    // The selection followed the commit, not the row it used to occupy.
    await expect(
      details.getByRole("heading", { name: "Merge branch 'trellis'" }),
    ).toBeVisible();
    await expect(extra.locator("g.commit.selected")).toContainText(
      "Merge branch 'trellis'",
    );
  });

  test("a selected commit that leaves the graph is reported, not silently swapped", async ({
    page,
  }) => {
    await openGarden(page);
    const extra = plot(page, "Extra 1");
    await extra
      .locator("g.commit", { hasText: "trellis" })
      .filter({ hasText: "Build the trellis" })
      .click();
    const details = page.getByRole("complementary", { name: "Commit details" });
    await expect(
      details.getByRole("heading", { name: "Build the trellis" }),
    ).toBeVisible();
    // Deleting the branch leaves its old commit with no reason to be shown.
    await runGit(["branch", "-D", "trellis"], {
      cwd: join(root, "extra-1"),
      env: FIXTURE_ENV,
    });
    await expect(details).toContainText("is no longer in the current graph", {
      timeout: 15_000,
    });
  });
});
