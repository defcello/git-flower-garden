/*
 * Roadmap P2-B exit: the complete graph fixture suite inspected in every
 * renderer gives identical semantic results, and no flower or fruit makes a
 * ref inaccessible (every ref-bearing commit is reachable at its own
 * position, and its details list every ref).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { GraphJson } from "../../src/api/types.ts";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture } from "../../src/demo/builder.ts";
import { artProof, demoFixtures } from "../../src/demo/fixtures.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";

// Configuration ids are lowercase: forkMerge becomes fork-merge.
const FIXTURES = Object.fromEntries(
  Object.entries({ ...demoFixtures, artProof }).map(([name, spec]) => [
    name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    spec,
  ]),
);
const IDS = Object.keys(FIXTURES);

let app: RunningApp;
let root: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  root = await mkdtemp(join(tmpdir(), "git-flower-garden-fidelity-"));
  for (const [id, spec] of Object.entries(FIXTURES))
    await buildFixture(spec, join(root, id));
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: IDS.map((id) => ({ id, path: id })),
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

test.use({ viewport: { width: 1920, height: 1080 } });

/** What the focused graph means, independent of how it is drawn. */
function semantics(page: Page) {
  return page.locator(".focus-graph svg.graph").evaluate((svg) => ({
    nodes: Array.from(svg.querySelectorAll(".commit")).map((node) => ({
      oid: node.getAttribute("data-oid"),
      text: node.textContent,
    })),
    edges: Array.from(svg.querySelectorAll(".edge")).map((edge) =>
      edge.getAttribute("d"),
    ),
    badges: Array.from(svg.querySelectorAll(".badge")).map((badge) =>
      badge.getAttribute("data-hidden"),
    ),
    tails: svg.querySelectorAll(".tail").length,
    boundaries: svg.querySelectorAll(".tail.boundary").length,
    worktrees: svg.querySelectorAll(".worktree").length,
  }));
}

async function focus(page: Page, id: string) {
  await page.locator(`[data-plot="${id}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".focus-graph")).toHaveAttribute(
    "data-framed",
    "true",
  );
}

async function leave(page: Page) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".focus-graph")).toHaveCount(0);
}

test("every fixture means the same in every renderer", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(app.url);
  const truth = new Map<string, unknown>();
  for (const renderer of ["technical", "canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(renderer);
    for (const id of IDS) {
      await focus(page, id);
      if (renderer === "canvas")
        await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(1);
      const seen = await semantics(page);
      expect(seen.nodes.length, id).toBeGreaterThan(0);
      if (renderer === "technical") truth.set(id, seen);
      else expect(seen, `${id} in ${renderer}`).toEqual(truth.get(id));
      await leave(page);
    }
  }
});

test("no flower or fruit makes a ref inaccessible", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(app.url);
  for (const renderer of ["canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(renderer);
    for (const id of IDS) {
      const graph = (await (
        await page.request.get(`${app.url}api/repositories/${id}/graph`)
      ).json()) as GraphJson;
      await focus(page, id);
      for (const node of graph.nodes.filter((n) => n.refs.length > 0)) {
        const where = `${id} ${node.oid.slice(0, 7)} in ${renderer}`;
        // The commit's own mark, located in the overlay.
        const point = await page
          .locator(
            `.focus-graph svg.graph g.commit[data-oid="${node.oid}"] .node`,
          )
          .first()
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        // Nothing drawn over it (flowers, fruit, leaves) intercepts the pointer.
        const hit = await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("g.commit")
              ?.getAttribute("data-oid") ?? null,
          point,
        );
        expect(hit, where).toBe(node.oid);
        await page.mouse.click(point.x, point.y);
        const details = page.getByRole("complementary", {
          name: "Commit details",
        });
        await expect(details.locator(".oid-full"), where).toHaveText(node.oid);
        for (const ref of node.refs)
          await expect(details, `${where}: ${ref}`).toContainText(
            ref.replace(/^tag: /, ""),
          );
      }
      await leave(page);
    }
  }
});
