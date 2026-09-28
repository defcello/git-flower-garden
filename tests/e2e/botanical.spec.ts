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
  // Pinning details from the overview is a technical-view interaction; on
  // the garden hillside a click focuses the whole plant (section 7).
  const fork = page.locator('[data-plot="fork"]');
  await fork.locator("g.commit", { hasText: "main, release" }).click();
  const details = page.getByRole("complementary", { name: "Commit details" });
  await expect(details.locator(".chips li")).toHaveText(["main", "release"]);
  await expect(details).toContainText("Worktrees");
  await page.keyboard.press("Escape");
  for (const compositor of ["canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(compositor);
    await expect(
      page.locator(`.botanical-graph[data-compositor="${compositor}"]`),
    ).toHaveCount(7);
    if (compositor === "canvas")
      await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(7);
    expect(await semantic()).toEqual(truth);
  }
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

test("sky previews at 1080p and 4K are marked as previews and load local art", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(7);
  const landscape = page.locator(".landscape");
  const scene = page.locator(".landscape-scene");
  const note = page.locator(".art-notice");
  // The fixture configures no location: Live is lit by the noon Sun.
  await expect(landscape).toHaveAttribute("data-sky", "day");
  await expect(note).toContainText("set a location");
  // The ridge and hill are relit in a worker (ADR 0018, step 3).
  await expect(scene).toHaveAttribute("data-art", "ready");
  await expect(scene).toHaveAttribute("data-lit", "true");
  await expect(scene).toHaveAttribute("data-sun", "true");
  await expect(scene).toHaveAttribute("data-stars", "false");
  const sky = page.getByLabel("Sky", { exact: true });
  await expect(sky.locator("option").first()).toHaveText(
    "Live · no location configured",
  );

  const cases = [
    { name: "noon", sun: true, moon: false, stars: false },
    { name: "sunrise", sun: true, moon: false, stars: false },
    { name: "civil-dusk", sun: false, moon: true, stars: false },
    { name: "full-moon", sun: false, moon: true, stars: true },
    { name: "night", sun: false, moon: false, stars: true },
    { name: "daytime-moon", sun: true, moon: true, stars: false },
    { name: "polar-night", sun: false, moon: true, stars: true },
  ];
  for (const width of [1920, 3840]) {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    for (const preview of cases) {
      await sky.selectOption(preview.name);
      await expect(landscape).toHaveAttribute("data-sky", preview.name);
      await expect(note).toContainText("Sky preview");
      await expect(note).toContainText("not live conditions");
      await expect(scene).toHaveAttribute("data-sun", String(preview.sun));
      await expect(scene).toHaveAttribute("data-moon", String(preview.moon));
      await expect(scene).toHaveAttribute("data-stars", String(preview.stars));
      await page.screenshot({
        path: testInfo.outputPath(`${preview.name}-${String(width)}.png`),
      });
    }
  }
  // The sky is decoration: it never takes pointer input from the garden.
  expect(
    await scene.evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe("none");
  // The hill is relit: far darker at night than at noon. Sample the grass
  // once each relight has landed (the light key changes the art).
  const grass = () =>
    scene.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const data = canvas
        .getContext("2d")
        ?.getImageData(canvas.width / 2 - 20, canvas.height * 0.9, 40, 10).data;
      let sum = 0;
      for (let i = 0; i < (data?.length ?? 0); i += 4)
        sum += (data?.[i] ?? 0) + (data?.[i + 1] ?? 0) + (data?.[i + 2] ?? 0);
      return sum / ((data?.length ?? 4) / 4) / 3;
    });
  await sky.selectOption("noon");
  await expect.poll(grass).toBeGreaterThan(60);
  const day = await grass();
  await sky.selectOption("night");
  await expect.poll(grass).toBeLessThan(day / 4);
  await sky.selectOption("live");
  await expect(landscape).toHaveAttribute("data-sky", "day");
  await expect(note).not.toContainText("Sky preview");
  // Also exercise narrow screens and DPR-independent vector hit regions.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Renderer", { exact: true })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("the scene always shows whole at 16:9, and the time slider and bookmarks agree", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  const landscape = page.locator(".landscape");
  const scene = page.locator(".landscape-scene");
  await expect(scene).toHaveAttribute("data-art", "ready");
  // Taller, wider, and phone windows: the stage fits inside, centered, at
  // 16:9, and the plants share it with the landscape.
  for (const [width, height] of [
    [1440, 1080],
    [2560, 1080],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(async () => (await landscape.boundingBox())?.width)
      .toBeCloseTo(Math.min(width, (height * 16) / 9), 0);
    const stage = await landscape.boundingBox();
    const garden = await page.locator(".garden-scene").boundingBox();
    expect(stage?.height).toBeCloseTo(((stage?.width ?? 0) * 9) / 16, 0);
    expect(stage?.x).toBeCloseTo((width - (stage?.width ?? 0)) / 2, 0);
    expect(stage?.y).toBeCloseTo((height - (stage?.height ?? 0)) / 2, 0);
    expect(garden).toEqual(stage);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  const sky = page.getByLabel("Sky", { exact: true });
  const slider = page.getByLabel("Time of day");
  const note = page.locator(".art-notice");
  // A bookmark sets the slider to its local time (01:06 EDT).
  await sky.selectOption("full-moon");
  await expect(slider).toHaveValue(String(60 + 6));
  await expect(page.locator(".time-readout")).toHaveText("01:06");
  // Moving the slider keeps the bookmark's date and place, shows a custom
  // time, and relights the scene.
  await slider.fill(String(12 * 60));
  await expect(sky).toHaveValue("custom");
  await expect(landscape).toHaveAttribute("data-sky", "custom");
  await expect(note).toContainText("Sky preview");
  await expect(note).toContainText("May 23, 2024, 12:00 EDT");
  await expect(scene).toHaveAttribute("data-sun", "true");
  await slider.fill(String(22 * 60));
  await expect(scene).toHaveAttribute("data-sun", "false");
  await expect(scene).toHaveAttribute("data-stars", "true");
  // Live returns to the clock.
  await sky.selectOption("live");
  await expect(landscape).toHaveAttribute("data-sky", "day");
  await expect(note).not.toContainText("Sky preview");
});

test("missing art falls back to the technical drawing", async ({ page }) => {
  await page.route("**/sprites-albedo-*.png", (route) => route.abort());
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
  // The technical view is the baseline both compositors are judged against.
  for (const renderer of ["technical", "canvas", "svg"]) {
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

// A realistic 2,000-commit selection is tall (one row per commit), so most of
// it is off screen in focus view. Evidence for ADR 0016, not a timing gate.
test("measure the focus view on a tall 2000-commit history", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
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
      const dy = index * graph.size.height;
      const point = (p: { x: number; y: number }) => ({ x: p.x, y: p.y + dy });
      nodes.push(
        ...graph.nodes.map((node) => ({
          ...node,
          ...point(node),
          row: node.row + index * graph.nodes.length,
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
        size: { ...graph.size, height: graph.size.height * copies },
      },
    });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await expect(page.locator('[data-plot="tour"] g.commit')).toHaveCount(2000);
  await page.locator('[data-plot="tour"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".focus-graph")).toHaveAttribute(
    "data-framed",
    "true",
  );
  const zoomSamples = () =>
    page.evaluate(async () => {
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
      const s = elapsed.slice(4).sort((a, b) => a - b);
      return { medianMs: s[10], p95Ms: s[18], maxMs: s[19] };
    });
  // Culling must never drop a commit whose row is on screen.
  const missingOnScreen = () =>
    page.evaluate(async () => {
      const graph = (await (
        await fetch("/api/repositories/tour/graph")
      ).json()) as import("../../src/api/types.ts").GraphJson;
      const view = document.querySelector<HTMLElement>(".focus-graph");
      if (!view) return ["no focus graph"];
      const scale = Number(view.dataset.scale);
      const y = Number(view.dataset.y);
      const drawn = new Set(
        Array.from(view.querySelectorAll(".graph g.commit")).map((g) =>
          g.getAttribute("data-oid"),
        ),
      );
      return graph.nodes
        .filter((n) => {
          const sy = n.y * scale + y;
          return sy > -20 && sy < view.clientHeight + 20;
        })
        .filter((n) => !drawn.has(n.oid))
        .map((n) => n.oid);
    });
  const measurements: Record<string, unknown> = {};
  for (const renderer of ["technical", "canvas", "svg"]) {
    await page.getByLabel("Renderer", { exact: true }).selectOption(renderer);
    if (renderer === "canvas")
      await expect(page.locator('canvas[data-ready="true"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    expect(await missingOnScreen(), renderer).toEqual([]);
    // Drag through the history in steps; every step keeps visible rows drawn.
    const box = await page.locator(".focus-graph").boundingBox();
    if (!box) throw new Error("focus graph");
    for (let step = 0; step < 6; step++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 8 });
      await page.mouse.up();
      expect(
        await missingOnScreen(),
        `${renderer} pan ${String(step)}`,
      ).toEqual([]);
    }
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const fitScale = await page
      .locator(".focus-graph")
      .getAttribute("data-scale");
    const atFit = await zoomSamples();
    const drawnAtFit = await page.locator(".focus-graph g.commit").count();
    // Zoom to a readable scale (labels at full size) and measure there too.
    while (
      Number(await page.locator(".focus-graph").getAttribute("data-scale")) < 1
    )
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(await missingOnScreen(), `${renderer} readable`).toEqual([]);
    const atReadable = await zoomSamples();
    const drawnAtReadable = await page.locator(".focus-graph g.commit").count();
    measurements[renderer] = {
      fitScale,
      atFit,
      drawnAtFit,
      atReadable,
      drawnAtReadable,
    };
  }
  await testInfo.attach("tall-history-timings.json", {
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
  console.log("Tall history:", JSON.stringify(measurements));
});
