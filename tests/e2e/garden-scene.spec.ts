/*
 * The garden view's hillside under the section 7 contract, at a small (5)
 * and a full (64) garden, at 1920x1080:
 * - technical stays the default; the viewer's choice is remembered;
 * - the unattended scene carries no text, icons, or highlight (maintainer
 *   design); hovering a plant or its icon reveals that plant's icon and
 *   name card and outlines that plant, and only that plant, in cyan;
 * - clicking the plant or its icon focuses exactly that repository;
 * - plants grow from their fixed hillside slots, and every one of the 64
 *   fixed icons is reachable (never covered);
 * - empty and broken repositories stay visible without text.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture, fixtureGit } from "../../src/demo/builder.ts";
import {
  artProof,
  crissCross,
  forkMerge,
  threeHeads,
} from "../../src/demo/fixtures.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";
import { HILLSIDE_SLOTS, hillsideSlots } from "../../src/ui/hillside.ts";

const CYAN = "rgb(0, 229, 255)";

let small: RunningApp;
let full: RunningApp;
let root: string;

interface Entry {
  id: string;
  label: string;
  path: string;
}

const SMALL: Entry[] = [
  { id: "tour", label: "Garden tour", path: "tour" },
  { id: "fork", label: "Fork and merge", path: "fork" },
  { id: "three", label: "Three heads", path: "three" },
  { id: "empty", label: "Empty repository", path: "empty" },
  { id: "missing", label: "Missing path", path: "nowhere" },
];

// 64 plants from a few real repositories (paths may repeat; ids may not).
const REAL = ["tour", "fork", "three", "criss"];
const FULL: Entry[] = Array.from({ length: 64 }, (_, i) => ({
  id: `r${String(i)}`,
  label: `Repository ${String(i)}`,
  path: i === 17 ? "empty" : i === 40 ? "nowhere" : (REAL[i % 4] ?? "tour"),
}));

async function start(repositories: Entry[]) {
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories,
    }),
    root,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return startApp(parsed.config, {
    now: () => Date.parse("2026-09-22T15:00:00-04:00"),
    port: 0,
    cacheRoot: join(root, ".cache"),
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = await mkdtemp(join(tmpdir(), "git-flower-garden-scene-"));
  await buildFixture(artProof, join(root, "tour"));
  await buildFixture(forkMerge, join(root, "fork"));
  await buildFixture(threeHeads, join(root, "three"));
  await buildFixture(crissCross, join(root, "criss"));
  await mkdir(join(root, "empty"));
  await fixtureGit(root, ["init", "--quiet", join(root, "empty")]);
  small = await start(SMALL);
  full = await start(FULL);
});

test.afterAll(async () => {
  await small.close();
  await full.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test.use({ viewport: { width: 1920, height: 1080 } });

async function openScene(page: Page, url: string, plants: number) {
  await page.goto(url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator(".garden-scene [data-plot]")).toHaveCount(plants);
  await expect(
    page.locator(".garden-scene .status", { hasText: "Loading" }),
  ).toHaveCount(0);
  await page.mouse.move(2, 2);
}

/**
 * Which plots are revealed (icon shown) and outlined in cyan: by the scene
 * canvas (Canvas compositor) or by the plot's CSS (SVG compositor).
 */
async function lit(page: Page) {
  return page.locator("[data-plot]").evaluateAll((plots, cyan) => {
    const garden = document.querySelector<HTMLElement>(".garden-canvas");
    return plots
      .filter((plot) => {
        const plant = plot.querySelector(".plant");
        const icon = plot.querySelector(".focus-button");
        const outlined = garden
          ? garden.dataset.highlight === plot.getAttribute("data-plot")
          : plant !== null && getComputedStyle(plant).filter.includes(cyan);
        return (
          outlined && icon !== null && getComputedStyle(icon).opacity === "1"
        );
      })
      .map((plot) => plot.getAttribute("data-plot"));
  }, CYAN);
}

/** Cyan pixels in the scene canvas: the hover outline, drawn. */
async function cyanPixels(page: Page) {
  return page.locator(".garden-canvas").evaluate((node: HTMLCanvasElement) => {
    // Read through a 2D copy, so either tier's canvas works.
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const g = copy.getContext("2d");
    g?.drawImage(node, 0, 0);
    const data = g?.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0;
    for (let i = 0; i < (data?.length ?? 0); i += 4) {
      const [r, g, b, a] = [
        data?.[i],
        data?.[i + 1],
        data?.[i + 2],
        data?.[i + 3],
      ];
      if ((a ?? 0) > 60 && (r ?? 255) < 120 && (g ?? 0) > 170 && (b ?? 0) > 190)
        count++;
    }
    return count;
  });
}

/** A point on the plant not under any other element (an icon or another plant). */
async function exposedPoint(page: Page, id: string) {
  return page.evaluate((plotId) => {
    const plant = document.querySelector(`[data-plot="${plotId}"] .plant`);
    if (!plant) return null;
    const targets = plant.querySelectorAll(
      ".commit .hit, .plant-bed, .plant-stake, .stake-tag",
    );
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      for (const fy of [0.5, 0.3, 0.7, 0.1, 0.9]) {
        for (const fx of [0.5, 0.3, 0.7, 0.1, 0.9]) {
          const x = box.left + box.width * fx;
          const y = box.top + box.height * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && plant.contains(hit)) return { x, y };
        }
      }
    }
    return null;
  }, id);
}

async function iconCenter(page: Page, id: string) {
  const box = await page
    .locator(`[data-plot="${id}"] .focus-button`)
    .boundingBox();
  if (!box) throw new Error(`no icon for ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where each plant's anchor (tree center at its base) lands in the viewport. */
async function basePoints(page: Page) {
  return page.locator("[data-plot] .plant").evaluateAll((plants) =>
    plants.map((plant) => {
      const box = plant.getBoundingClientRect();
      const style = getComputedStyle(plant);
      const scale = Number(style.getPropertyValue("--plant-scale"));
      const anchor = parseFloat(style.getPropertyValue("--anchor-x"));
      return { x: box.left + anchor * scale, y: box.bottom };
    }),
  );
}

test("technical is the default; the garden choice is remembered", async ({
  page,
}) => {
  await page.goto(small.url);
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

test("the unattended scene has no text, icons, or highlight", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  expect(await lit(page)).toEqual([]);
  for (const { id } of SMALL) {
    const plot = page.locator(`[data-plot="${id}"]`);
    await expect(plot.locator(".plot-card"), id).toHaveCSS("opacity", "0");
    await expect(plot.locator(".focus-button"), id).toHaveCSS("opacity", "0");
  }
  for (const id of ["empty", "missing"]) {
    const box = await page
      .locator(`[data-plot="${id}"] .placeholder`)
      .boundingBox();
    expect(box?.width ?? 0, id).toBeLessThanOrEqual(1);
  }
});

test("hovering a plant reveals its icon and name and outlines it in cyan; clicking it focuses", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  const point = await exposedPoint(page, "fork");
  if (!point) throw new Error("fork plant is not exposed");
  const unlit = await cyanPixels(page);
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => lit(page)).toEqual(["fork"]);
  await expect.poll(() => cyanPixels(page)).toBeGreaterThan(unlit + 100);
  const fork = page.locator('[data-plot="fork"]');
  await expect(fork.locator(".plot-card")).toHaveCSS("opacity", "1");
  await expect(fork.locator("h2")).toHaveText("Fork and merge");
  expect(
    await fork.locator("h2").evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await expect(fork.locator(".status")).toContainText("Up to date");
  // No commit tooltip competes with the card on the hillside.
  await expect(page.locator(".tooltip")).toHaveCount(0);
  // The revealed icon is not covered by the card or any plant.
  const icon = await iconCenter(page, "fork");
  expect(
    await fork
      .locator(".focus-button")
      .evaluate(
        (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
        icon,
      ),
  ).toBe(true);
  // Clicking the plant itself focuses exactly this repository.
  await page.mouse.click(point.x, point.y);
  await expect(
    page.getByRole("button", { name: "Show all repositories" }),
  ).toBeVisible();
  await expect(page.locator(".focus-head h2")).toHaveText("Fork and merge");
  await page.getByRole("button", { name: "Show all repositories" }).click();
  await expect(page.locator(".garden-scene")).toHaveCount(1);
});

test("weather falls over the hillside but never covers a plant or its icon", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  await page
    .getByLabel("Weather", { exact: true })
    .selectOption("thunderstorm");
  const overlay = page.locator(".weather-overlay");
  await expect(overlay).toHaveAttribute("data-precipitation", "rain");
  await expect(overlay).toHaveCSS("pointer-events", "none");
  await expect(page.locator(".weather-fall")).toHaveAttribute(
    "data-particles",
    /^[1-9]/,
  );
  // Every plant can still be pointed at and its icon is never covered.
  for (const id of ["tour", "fork", "three"]) {
    const point = await exposedPoint(page, id);
    expect(point, id).not.toBeNull();
    if (!point) continue;
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => lit(page)).toEqual([id]);
    const icon = await iconCenter(page, id);
    expect(
      await page
        .locator(`[data-plot="${id}"] .focus-button`)
        .evaluate(
          (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
          icon,
        ),
      id,
    ).toBe(true);
  }
  const point = await exposedPoint(page, "fork");
  if (!point) throw new Error("fork plant is not exposed");
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".focus-head h2")).toHaveText("Fork and merge");
  // The focus view stays dry, for reading.
  await expect(page.locator(".weather-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all repositories" }).click();
  await expect(page.locator(".weather-overlay")).toHaveCount(1);
});

test("hovering an icon reveals it and outlines its own plant; clicking it focuses", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  const icon = await iconCenter(page, "tour");
  await page.mouse.move(icon.x, icon.y);
  await expect.poll(() => lit(page)).toEqual(["tour"]);
  await page.mouse.click(icon.x, icon.y);
  await expect(page.locator(".focus-head h2")).toHaveText("Garden tour");
});

test("keyboard focus reveals and outlines a plant; Enter focuses it", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  await page.locator('[data-plot="three"]').focus();
  await expect.poll(() => lit(page)).toEqual(["three"]);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Show all repositories" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-plot="three"]')).toBeFocused();
});

test("empty and broken repositories stay visible without text, and are targets too", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  for (const id of ["tour", "fork", "three"]) {
    await expect(
      page.locator(`[data-plot="${id}"] .plant-marker`),
      id,
    ).toHaveCount(0);
  }
  const empty = page.locator('[data-plot="empty"]');
  await expect(empty.locator(".plant-bed")).toBeVisible();
  await expect(empty.locator(".stake-tag")).toHaveCount(0);
  const missing = page.locator('[data-plot="missing"]');
  // Only a repository with no commits gets a soil bed (maintainer
  // decision); an unreadable one is just its stake, never invisible.
  await expect(missing.locator(".plant-bed")).toHaveCount(0);
  await expect(missing.locator(".stake-tag")).toBeVisible();
  await expect(missing.locator(".stake-tag")).toHaveText("✕");
  // Hovering the stake explains it; hovering the bed too, and clicking focuses.
  const point = await exposedPoint(page, "missing");
  if (!point) throw new Error("missing stake is not exposed");
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => lit(page)).toEqual(["missing"]);
  await expect(missing.locator(".status")).toContainText("Path not found");
  const bed = await exposedPoint(page, "empty");
  if (!bed) throw new Error("empty bed is not exposed");
  await page.mouse.move(bed.x, bed.y);
  await expect.poll(() => lit(page)).toEqual(["empty"]);
  await expect(empty.locator(".status")).toContainText("no commits yet");
  await page.mouse.click(bed.x, bed.y);
  await expect(page.locator(".focus-head h2")).toHaveText("Empty repository");
  await page.getByRole("button", { name: "Show all repositories" }).click();
  // The technical renderer keeps names and status always visible.
  await page.getByLabel("Renderer", { exact: true }).selectOption("technical");
  await page.mouse.move(2, 2);
  await expect(page.locator(".plant-marker")).toHaveCount(0);
  await expect(missing.locator("h2")).toBeVisible();
  await expect(missing.locator(".status")).toContainText("Error");
});

test("small gardens are spread evenly over the fixed hillside slots", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  const expected = hillsideSlots(5).map((s) => HILLSIDE_SLOTS[s]);
  const bases = await basePoints(page);
  expect(bases).toHaveLength(5);
  for (const [i, base] of bases.entries()) {
    const slot = expected[i];
    if (!slot) throw new Error("slot");
    const id = SMALL[i]?.id;
    expect(Math.abs(base.x - (slot.x / 100) * 1920), id).toBeLessThan(2);
    expect(Math.abs(base.y - (slot.y / 100) * 1080), id).toBeLessThan(2);
  }
});

/** Commits whose knot is not painted where their (invisible) node sits. */
function knotMisses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".garden-canvas");
    // Read through a 2D copy, so either tier's canvas works.
    const copy = document.createElement("canvas");
    const g = copy.getContext("2d");
    if (!canvas || !g) return ["no canvas"];
    copy.width = canvas.width;
    copy.height = canvas.height;
    g.drawImage(canvas, 0, 0);
    const box = canvas.getBoundingClientRect();
    const k = canvas.width / box.width;
    const missed: string[] = [];
    for (const node of document.querySelectorAll(".garden-scene .node")) {
      const r = node.getBoundingClientRect();
      const x = Math.round((r.left + r.width / 2 - box.left) * k);
      const y = Math.round((r.top + r.height / 2 - box.top) * k);
      if ((g.getImageData(x, y, 1, 1).data[3] ?? 0) === 0)
        missed.push(
          node.closest("[data-oid]")?.getAttribute("data-oid") ?? "?",
        );
    }
    return missed;
  });
}

test("the scene canvas draws each plant under its own hit targets", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  const garden = page.locator('.garden-canvas[data-ready="true"]');
  // Every drawn plot: tour, fork, and three (empty and missing have none).
  await expect(garden).toHaveAttribute("data-plants", "3");
  // Each commit's knot is painted where its (invisible) node sits.
  expect(await knotMisses(page)).toEqual([]);
});

test("64 plants: each grows from its own slot, and all 64 icons are reachable", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openScene(page, full.url, 64);
  const bases = await basePoints(page);
  for (const [i, base] of bases.entries()) {
    const slot = HILLSIDE_SLOTS[i];
    if (!slot) throw new Error("slot");
    const id = `r${String(i)}`;
    expect(Math.abs(base.x - (slot.x / 100) * 1920), id).toBeLessThan(2);
    expect(Math.abs(base.y - (slot.y / 100) * 1080), id).toBeLessThan(2);
  }
  // Every icon is at its fixed position and on top: hovering it reveals it
  // and outlines exactly its own plant.
  for (let i = 0; i < 64; i++) {
    const id = `r${String(i)}`;
    const slot = HILLSIDE_SLOTS[i];
    if (!slot) throw new Error("slot");
    const icon = await iconCenter(page, id);
    expect(Math.abs(icon.x - (slot.iconX / 100) * 1920), id).toBeLessThan(2);
    expect(Math.abs(icon.y - (slot.iconY / 100) * 1080), id).toBeLessThan(2);
    await page.mouse.move(icon.x, icon.y);
    await expect.poll(() => lit(page), { message: id }).toEqual([id]);
  }
  // Clicking icons, back and front, focuses exactly that repository.
  for (const i of [0, 27, 63]) {
    await page.mouse.move(2, 2);
    const icon = await iconCenter(page, `r${String(i)}`);
    await page.mouse.click(icon.x, icon.y);
    await expect(page.locator(".focus-head h2")).toHaveText(
      `Repository ${String(i)}`,
    );
    await page.getByRole("button", { name: "Show all repositories" }).click();
    await expect(page.locator(".garden-scene [data-plot]")).toHaveCount(64);
  }
  // Clicking an exposed part of a front plant focuses that plant.
  await page.mouse.move(2, 2);
  const point = await exposedPoint(page, "r60");
  if (!point) throw new Error("r60 is not exposed");
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => lit(page)).toEqual(["r60"]);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".focus-head h2")).toHaveText("Repository 60");
});

test("more than 64 repositories use the card layout", async ({ page }) => {
  test.setTimeout(120_000);
  const extra = await start([
    ...FULL,
    { id: "r64", label: "Repository 64", path: "tour" },
  ]);
  try {
    await page.goto(extra.url);
    await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
    await expect(page.locator("[data-plot]")).toHaveCount(65);
    await expect(page.locator(".garden-scene")).toHaveCount(0);
  } finally {
    await extra.close();
  }
});

/** A canvas's artwork as an image, for telling whether it moved. */
async function artwork(page: Page, selector: string) {
  const canvas = page.locator(selector);
  await expect(canvas).toHaveAttribute("data-ready", "true");
  return canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
}

/**
 * Hold the light still (a preview, not the live sky), and wait until the
 * relit art for it is on screen, so only sway can change the artwork.
 */
async function holdLight(page: Page) {
  await page.getByLabel("Sky", { exact: true }).selectOption("noon");
  const scene = page.locator(".landscape-scene");
  await expect
    .poll(() =>
      scene.evaluate(
        (element: HTMLElement) =>
          element.dataset.artLight !== undefined &&
          element.dataset.artLight === element.dataset.skyLight,
      ),
    )
    .toBe(true);
  // Let the plants' art catch up with the scene's.
  await page.waitForTimeout(300);
}

/** Whether a canvas's artwork changes over half a second (a few sway frames). */
async function moves(page: Page, selector: string) {
  const before = await artwork(page, selector);
  await page.waitForTimeout(500);
  return (await artwork(page, selector)) !== before;
}

test("leaves sway in the garden only, hit targets stay put, and Static and Low stand still", async ({
  page,
}) => {
  await openScene(page, small.url, 5);
  const tour = '[data-plot="tour"]';
  // The hillside's plants are all drawn by the one scene canvas.
  const garden = ".garden-canvas";
  await expect(page.getByLabel("Drawing", { exact: true })).toHaveValue("auto");
  await expect(page.getByLabel("Quality", { exact: true })).toHaveValue("high");
  const targets = () =>
    page
      .locator(`${tour} .node`)
      .evaluateAll((nodes) =>
        nodes.map((node) => JSON.stringify(node.getBoundingClientRect())),
      );
  const still = await targets();
  expect(await moves(page, garden)).toBe(true);
  expect(await targets()).toEqual(still);
  // A slow machine may step High down to Balanced's rate, but keeps swaying.
  expect(
    await page.evaluate(() => document.documentElement.dataset.sway),
  ).not.toBe("slow");

  // The SVG compositor sways the same art.
  await page.getByLabel("Renderer", { exact: true }).selectOption("svg");
  const sprites = page.locator(`${tour} .botanical-art g[transform]`);
  const first = await sprites.first().getAttribute("transform");
  await page.waitForTimeout(500);
  expect(await sprites.first().getAttribute("transform")).not.toBe(first);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");

  // Static draws nothing between lighting changes, and is remembered.
  await page.getByLabel("Drawing", { exact: true }).selectOption("static");
  await page.waitForTimeout(200);
  expect(await moves(page, garden)).toBe(false);
  await page.reload();
  await expect(page.getByLabel("Drawing", { exact: true })).toHaveValue(
    "static",
  );
  await holdLight(page);
  expect(await moves(page, garden)).toBe(false);

  // Reduced motion stills every tier.
  await page.getByLabel("Drawing", { exact: true }).selectOption("auto");
  expect(await moves(page, garden)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  expect(await moves(page, garden)).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await moves(page, garden)).toBe(true);

  // Low quality keeps the plants still, puts them back at rest, and is
  // remembered; Balanced sways again.
  const quality = page.getByLabel("Quality", { exact: true });
  await quality.selectOption("low");
  await page.waitForTimeout(200);
  expect(await moves(page, garden)).toBe(false);
  expect(await targets()).toEqual(still);
  await page.reload();
  await expect(quality).toHaveValue("low");
  await holdLight(page);
  expect(await moves(page, garden)).toBe(false);
  await quality.selectOption("balanced");
  expect(await moves(page, garden)).toBe(true);

  // The focus view is for reading: its plant holds still.
  await page.locator(tour).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main.focus")).toBeVisible();
  expect(await moves(page, "main.focus .botanical-graph canvas")).toBe(false);
});

test("with the GPU tier, plants keep their places, outline, and sway, and a lost context hands them to Software", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("git-flower-garden.tier", "gpu");
  });
  await openScene(page, small.url, 5);
  const garden = page.locator('.garden-canvas[data-ready="true"]');
  await expect(garden).toHaveAttribute("data-tier", "gpu");
  await expect(garden).toHaveAttribute("data-plants", "3");
  expect(await knotMisses(page)).toEqual([]);

  // Hovering outlines the plant in cyan, drawn on the GPU.
  const point = await exposedPoint(page, "fork");
  if (!point) throw new Error("fork plant is not exposed");
  const unlit = await cyanPixels(page);
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => lit(page)).toEqual(["fork"]);
  await expect.poll(() => cyanPixels(page)).toBeGreaterThan(unlit + 100);
  await page.mouse.move(2, 2);
  await expect.poll(() => lit(page)).toEqual([]);

  // Leaves sway; hit targets stay put.
  const targets = () =>
    page
      .locator('[data-plot="tour"] .node')
      .evaluateAll((nodes) =>
        nodes.map((node) => JSON.stringify(node.getBoundingClientRect())),
      );
  const still = await targets();
  await holdLight(page);
  expect(await moves(page, ".garden-canvas")).toBe(true);
  expect(await targets()).toEqual(still);

  // A lost context: Software draws the plants at once, from relit sprites,
  // and the GPU takes them back when the context returns.
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.garden-canvas[data-tier="gpu"]',
    );
    const lose = canvas
      ?.getContext("webgl2")
      ?.getExtension("WEBGL_lose_context");
    (window as unknown as { lose: typeof lose }).lose = lose;
    lose?.loseContext();
  });
  await expect(garden).toHaveAttribute("data-tier", "software");
  expect(await knotMisses(page)).toEqual([]);
  await page.evaluate(() => {
    (
      window as unknown as { lose: WEBGL_lose_context | null }
    ).lose?.restoreContext();
  });
  await expect(garden).toHaveAttribute("data-tier", "gpu");
  expect(await knotMisses(page)).toEqual([]);
});
