import { expect, test } from "@playwright/test";

// The service supplies real Git fixtures. Compare semantic output rather than
// snapshots alone: artwork must never change OIDs, ancestry, or ref inspection.
test("garden compositors retain graph truth, selection, and focus camera", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  const semantic = () =>
    page.locator("section.plot svg.graph").evaluateAll((graphs) =>
      graphs.map((graph) => ({
        nodes: Array.from(graph.querySelectorAll(".commit")).map((node) => ({
          oid: node.getAttribute("data-oid"),
          text: node.textContent,
        })),
        edges: Array.from(graph.querySelectorAll(".edge")).map((edge) =>
          edge.getAttribute("d"),
        ),
        tails: graph.querySelectorAll(".tail").length,
      })),
    );
  const truth = await semantic();
  for (const compositor of ["canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(compositor);
    await expect(
      page.locator(`.botanical-graph[data-compositor="${compositor}"]`),
    ).toHaveCount(7);
    if (compositor === "canvas")
      await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(7);
    expect(await semantic()).toEqual(truth);
  }
  const fork = page.locator('[data-plot="fork"]');
  await fork.locator("g.commit", { hasText: "main, release" }).click();
  const details = page.getByRole("complementary", { name: "Commit details" });
  await expect(details.locator(".chips li")).toHaveText(["main", "release"]);
  await expect(details).toContainText("Worktrees");
  await page.keyboard.press("Escape");
  await fork.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".focus-graph")).toHaveAttribute(
    "data-framed",
    "true",
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const camera = await page.locator(".focus-graph").getAttribute("data-scale");
  const commit = page.getByRole("navigation").getByRole("button").first();
  await commit.focus();
  await page.keyboard.press("Enter");
  const oid = await details.locator(".oid-full").textContent();
  for (const renderer of ["technical", "canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(renderer);
    await expect(details.locator(".oid-full")).toHaveText(oid ?? "");
    await expect(page.locator(".focus-graph")).toHaveAttribute(
      "data-scale",
      camera ?? "",
    );
  }
});

test("lighting studies at 1080p and 4K remain explicit previews and load local art", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(7);
  for (const width of [1920, 3840]) {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    for (const lighting of ["day", "dawn", "dusk", "night"]) {
      await page
        .getByLabel("Lighting study", { exact: true })
        .selectOption(lighting);
      await expect(page.getByRole("note")).toContainText(
        `${lighting} lighting study, not live conditions`,
      );
      await page.screenshot({
        path: testInfo.outputPath(`${lighting}-${String(width)}.png`),
      });
    }
  }
  // Also exercise narrow screens and DPR-independent vector hit regions.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Renderer", { exact: true })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("missing atlas falls back to the technical drawing", async ({ page }) => {
  await page.route("**/botanical-atlas-*.png", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator(".botanical-graph")).toHaveCount(0);
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await expect(page.locator('[data-plot="tour"] .node').first()).toBeVisible();
});

// Reproducible compositor comparison on identical geometry and the same atlas.
// Measurements are evidence, not timing assertions tied to a particular CPU.
test("measure both compositors at the 2000 selected-node envelope", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.route("**/api/repositories/tour/graph", async (route) => {
    const response = await route.fetch();
    const graph =
      (await response.json()) as import("../../src/api/types.ts").GraphJson;
    const copies = 200;
    const nodes = [],
      edges = [],
      tails = [];
    for (let index = 0; index < copies; index++) {
      const prefix = `${String(index)}-`;
      const dx = (index % 20) * graph.size.width;
      const dy = Math.floor(index / 20) * graph.size.height;
      const point = (p: { x: number; y: number }) => ({
        x: p.x + dx,
        y: p.y + dy,
      });
      nodes.push(
        ...graph.nodes.map((node) => ({
          ...node,
          ...point(node),
          oid: prefix + node.oid,
          parents: node.parents.map((oid) => prefix + oid),
        })),
      );
      edges.push(
        ...graph.edges.map((edge) => ({
          ...edge,
          child: prefix + edge.child,
          parent: prefix + edge.parent,
          from: point(edge.from),
          to: point(edge.to),
        })),
      );
      tails.push(
        ...graph.tails.map((tail) => ({
          ...tail,
          child: prefix + tail.child,
          from: point(tail.from),
          to: point(tail.to),
        })),
      );
    }
    await route.fulfill({
      json: {
        ...graph,
        nodes,
        edges,
        tails,
        reachableCount: graph.reachableCount * copies,
        size: {
          ...graph.size,
          width: graph.size.width * 20,
          height: graph.size.height * 10,
        },
      },
    });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await expect(page.locator('[data-plot="tour"] g.commit')).toHaveCount(2000);
  await page.locator('[data-plot="tour"]').focus();
  await page.keyboard.press("Enter");
  const measurements: Record<string, unknown> = {};
  for (const renderer of ["canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(renderer);
    if (renderer === "canvas")
      await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(1);
    const samples = await page.evaluate(async () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".toolbar button"),
      );
      const elapsed = [];
      for (let index = 0; index < 24; index++) {
        const start = performance.now();
        buttons[index % 2]?.click();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          }),
        );
        elapsed.push(performance.now() - start);
      }
      return elapsed.slice(4).sort((a, b) => a - b);
    });
    measurements[renderer] = {
      medianMs: samples[10],
      p95Ms: samples[18],
      maxMs: samples[19],
    };
  }
  await testInfo.attach("compositor-timings.json", {
    body: JSON.stringify(
      {
        viewport: "1920x1080",
        nodes: 2000,
        metric: "zoom click to second animation frame, 4 warmups + 20 samples",
        userAgent: await page.evaluate(() => navigator.userAgent),
        measurements,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  console.log("Compositor comparison:", JSON.stringify(measurements));
});
