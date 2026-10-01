import { expect, test, type Page } from "@playwright/test";

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
    // On the hillside one canvas draws every plant (ADR 0018).
    if (compositor === "canvas") {
      const garden = page.locator('.garden-canvas[data-ready="true"]');
      await expect(garden).toHaveCount(1);
      await expect(garden).toHaveAttribute("data-plants", "7");
    }
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
  await expect(
    page.locator('.garden-canvas[data-ready="true"][data-plants="7"]'),
  ).toHaveCount(1);
  const landscape = page.locator(".landscape");
  const scene = page.locator(".landscape-scene");
  const note = page.locator(".art-notice");
  // The fixture turns the real sky off: Live is lit by the noon Sun.
  await expect(landscape).toHaveAttribute("data-sky", "day");
  await expect(note).toContainText("real sky is off");
  // The ridge and hill are relit in a worker (ADR 0018, step 3).
  await expect(scene).toHaveAttribute("data-art", "ready");
  await expect(scene).toHaveAttribute("data-lit", "true");
  await expect(scene).toHaveAttribute("data-sun", "true");
  await expect(scene).toHaveAttribute("data-stars", "false");
  const sky = page.getByLabel("Sky", { exact: true });
  await expect(sky.locator("option").first()).toHaveText("Live · real sky off");

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
  // Either tier may draw it (Auto takes a GPU where CI has one).
  const grass = async () =>
    (await brightness(page, [[0.49, 0.9, 0.02, 0.01]]))[0] ?? 0;
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
  // Drag through the day. The sky never runs ahead of the relit art: every
  // painted frame shows one light, and the scene catches up when dragging stops.
  await page.evaluate(() => {
    const canvas =
      document.querySelector<HTMLCanvasElement>(".landscape-scene");
    const state = window as unknown as { mixed: number; frames: number };
    state.mixed = 0;
    state.frames = 0;
    const sample = () => {
      const { skyLight, artLight } = canvas?.dataset ?? {};
      state.frames++;
      if (skyLight !== artLight) state.mixed++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let minutes = 5 * 60; minutes <= 21 * 60; minutes += 30)
    await slider.fill(String(minutes));
  const frames = await page.evaluate(() => {
    const { mixed, frames } = window as unknown as {
      mixed: number;
      frames: number;
    };
    return { mixed, frames };
  });
  expect(frames.frames).toBeGreaterThan(10);
  expect(frames.mixed).toBe(0);
  await expect(page.locator(".time-readout")).toHaveText("21:00");
  // The scene catches up to 21:00 (after sunset), sky and art together.
  await expect(scene).toHaveAttribute("data-sun", "false");
  expect(await scene.evaluate((node) => node.dataset.artLight)).toBe(
    await scene.evaluate((node) => node.dataset.skyLight),
  );

  // Live returns to the clock.
  await sky.selectOption("live");
  await expect(landscape).toHaveAttribute("data-sky", "day");
  await expect(note).not.toContainText("Sky preview");
});

/**
 * Make WebGL2 report `renderer` and pass `failIfMajorPerformanceCaveat`,
 * so a test decides what Auto sees, whatever GPU the machine has (CI's
 * macOS runner has one; Windows' fails the caveat). With `frameMs`, every
 * frame the GPU probe waits for takes that long.
 */
async function fakeGpu(page: Page, renderer: string, frameMs = 0) {
  await page.addInitScript(
    ([renderer, frameMs]) => {
      const original = (proto: object, name: string) =>
        Object.getOwnPropertyDescriptor(proto, name)?.value as (
          ...args: unknown[]
        ) => unknown;
      const getContext = original(HTMLCanvasElement.prototype, "getContext");
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        value(this: HTMLCanvasElement, type: string, options?: object) {
          return getContext.call(
            this,
            type,
            type === "webgl2"
              ? { ...options, failIfMajorPerformanceCaveat: false }
              : options,
          );
        },
      });
      const proto = WebGL2RenderingContext.prototype;
      const getParameter = original(proto, "getParameter");
      const readPixels = original(proto, "readPixels");
      Object.defineProperty(proto, "getParameter", {
        value(this: WebGL2RenderingContext, name: number) {
          // UNMASKED_RENDERER_WEBGL and RENDERER.
          if (name === 0x9246 || name === 0x1f01) return renderer;
          return getParameter.call(this, name);
        },
      });
      Object.defineProperty(proto, "readPixels", {
        value(this: WebGL2RenderingContext, ...args: unknown[]) {
          const end = performance.now() + frameMs;
          while (performance.now() < end);
          return readPixels.apply(this, args);
        },
      });
    },
    [renderer, frameMs] as const,
  );
}

/**
 * Mean brightness (0..255) of regions of the scene canvas, as fractions of
 * its size. Read through a 2D canvas, so it works for either tier.
 */
async function brightness(
  page: Page,
  regions: readonly (readonly [number, number, number, number])[],
): Promise<number[]> {
  return page.locator(".landscape-scene").evaluate(
    (node, boxes: [number, number, number, number][]) => {
      const scene = node as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = scene.width;
      copy.height = scene.height;
      const g = copy.getContext("2d");
      if (!g) return [];
      g.drawImage(scene, 0, 0);
      return boxes.map(([x, y, w, h]) => {
        const data = g.getImageData(
          Math.round(x * copy.width),
          Math.round(y * copy.height),
          Math.max(1, Math.round(w * copy.width)),
          Math.max(1, Math.round(h * copy.height)),
        ).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4)
          sum += (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
        return sum / (data.length / 4) / 3;
      });
    },
    regions.map(([x, y, w, h]): [number, number, number, number] => [
      x,
      y,
      w,
      h,
    ]),
  );
}

test("the GPU tier draws the landscape like Software, and hands over when its context is lost", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  const scene = page.locator(".landscape-scene");
  const drawing = page.getByLabel("Drawing", { exact: true });
  await drawing.selectOption("software");
  await expect(scene).toHaveAttribute("data-tier", "software");

  // Sky, far ridge, near hill, and grass low in the frame.
  const regions = [
    [0.4, 0.05, 0.2, 0.1],
    [0.1, 0.42, 0.1, 0.04],
    [0.45, 0.72, 0.1, 0.05],
    [0.47, 0.9, 0.06, 0.03],
  ] as const;
  const sky = page.getByLabel("Sky", { exact: true });
  // The sky's key for each preview, from its first (software) drawing.
  const keys: Record<string, string> = {};
  const skyKey = () => scene.evaluate((node) => node.dataset.skyLight ?? "");
  /** Wait until the scene shows `preview`'s light, lit whole. */
  const settled = async (preview: string, before: string) => {
    await expect(scene).toHaveAttribute("data-lit", "true");
    await expect
      .poll(async () => {
        const key = await skyKey();
        return keys[preview] === undefined
          ? key !== before
          : key === keys[preview];
      })
      .toBe(true);
    keys[preview] ??= await skyKey();
  };
  // Live is already the noon light here, so noon comes last.
  const cases = ["sunrise", "civil-dusk", "full-moon", "noon"];
  const software: Record<string, number[]> = {};
  for (const preview of cases) {
    const before = await skyKey();
    await sky.selectOption(preview);
    await settled(preview, before);
    software[preview] = await brightness(page, regions);
    await page.screenshot({
      path: testInfo.outputPath(`${preview}-software.png`),
    });
  }

  // GPU by hand accepts software WebGL too (headless Chromium's).
  await drawing.selectOption("gpu");
  await expect(scene).toHaveAttribute("data-tier", "gpu");
  // Whatever WebGL2 this machine has: headless Chromium's SwiftShader
  // here, a GPU on some CI runners.
  await expect(scene).toHaveAttribute("data-renderer", /\S/);
  for (const preview of cases) {
    await sky.selectOption(preview);
    await settled(preview, "");
    await page.screenshot({ path: testInfo.outputPath(`${preview}-gpu.png`) });
    // The same shading, so the same picture, give or take filtering.
    const gpu = await brightness(page, regions);
    gpu.forEach((value, i) => {
      expect(
        Math.abs(value - (software[preview]?.[i] ?? NaN)),
        `${preview}, region ${String(i)}: GPU ${value.toFixed(1)}, software ${String(software[preview]?.[i])}`,
      ).toBeLessThan(6);
    });
  }
  await sky.selectOption("full-moon");
  await settled("full-moon", "");
  await expect(scene).toHaveAttribute("data-sun", "false");
  await expect(scene).toHaveAttribute("data-moon", "true");
  await expect(scene).toHaveAttribute("data-stars", "true");
  // The plants still draw from sprites relit in the worker.
  await expect(
    page.locator('.garden-canvas[data-ready="true"][data-plants="7"]'),
  ).toHaveCount(1);

  // A lost context drops to Software at once, and the GPU returns when the
  // context is restored.
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.landscape-scene[data-tier="gpu"]',
    );
    const lose = canvas
      ?.getContext("webgl2")
      ?.getExtension("WEBGL_lose_context");
    (window as unknown as { lose: typeof lose }).lose = lose;
    lose?.loseContext();
  });
  await expect(scene).toHaveAttribute("data-tier", "software");
  await settled("full-moon", "");
  await page.evaluate(() => {
    (
      window as unknown as { lose: WEBGL_lose_context | null }
    ).lose?.restoreContext();
  });
  await expect(scene).toHaveAttribute("data-tier", "gpu");
  await settled("full-moon", "");

  // The choice is remembered.
  await page.reload();
  await expect(drawing).toHaveValue("gpu");
  await expect(scene).toHaveAttribute("data-tier", "gpu");
});

test("Auto refuses software WebGL, even when it passes the performance caveat", async ({
  page,
}) => {
  await fakeGpu(
    page,
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  );
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.getByLabel("Drawing", { exact: true })).toHaveValue("auto");
  // SwiftShader passes failIfMajorPerformanceCaveat in headless Chromium:
  // its name gives it away (ADR 0018, "Choosing a tier").
  expect(
    await page.evaluate(() => document.documentElement.dataset.gpu),
  ).toMatch(/^software: .*SwiftShader/);
  await expect(page.locator(".landscape-scene")).toHaveAttribute(
    "data-tier",
    "software",
  );
  await expect(page.locator(".garden-canvas")).toHaveAttribute(
    "data-tier",
    "software",
  );
});

test("the GPU tier draws the plants like Software, lit at once", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Nothing sways, so both tiers draw the same pose.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  const scene = page.locator(".landscape-scene");
  const garden = page.locator(".garden-canvas");
  const drawing = page.getByLabel("Drawing", { exact: true });
  const sky = page.getByLabel("Sky", { exact: true });
  // Software by name: on graphics hardware (--headed), Auto is the GPU.
  await drawing.selectOption("software");
  await expect(garden).toHaveAttribute("data-tier", "software");
  /** Wait until the landscape and the plants both show `preview`'s light. */
  const keys: Record<string, string> = {};
  const shows = async (preview: string, before: string) => {
    const shown = () =>
      page.evaluate(() => {
        const land = document.querySelector<HTMLElement>(".landscape-scene");
        const plants = document.querySelector<HTMLElement>(
          '.garden-canvas[data-ready="true"]',
        );
        const key = land?.dataset.skyLight ?? "";
        return land?.dataset.lit === "true" && plants?.dataset.artLight === key
          ? key
          : "";
      });
    await expect
      .poll(async () => {
        const key = await shown();
        return keys[preview] === undefined
          ? key !== "" && key !== before
          : key === keys[preview];
      })
      .toBe(true);
    keys[preview] ??= (await scene.getAttribute("data-sky-light")) ?? "";
  };
  /** The scene with its plants, as a picture, kept in the page by name. */
  const capture = (name: string) =>
    page.evaluate((key) => {
      const land =
        document.querySelector<HTMLCanvasElement>(".landscape-scene");
      const plants =
        document.querySelector<HTMLCanvasElement>(".garden-canvas");
      if (!land || !plants) throw new Error("no canvases");
      const copy = document.createElement("canvas");
      copy.width = plants.width;
      copy.height = plants.height;
      const g = copy.getContext("2d");
      if (!g) throw new Error("no 2d");
      g.drawImage(plants, 0, 0);
      const alpha = g.getImageData(0, 0, copy.width, copy.height).data;
      g.drawImage(land, 0, 0, copy.width, copy.height);
      g.drawImage(plants, 0, 0);
      const pictures = window as unknown as Record<
        string,
        { rgba: Uint8ClampedArray; alpha: Uint8ClampedArray; width: number }
      >;
      pictures[key] = {
        rgba: g.getImageData(0, 0, copy.width, copy.height).data,
        alpha,
        width: copy.width,
      };
    }, name);
  /**
   * Over 8×8 blocks where either tier drew a plant, the largest difference
   * of a block's mean color. Blocks, not pixels: sprites a few dozen pixels
   * across are resampled differently (mipmaps on the GPU, Canvas's
   * high-quality downscale in Software), which moves single pixels but not
   * what a viewer sees.
   */
  const differs = (a: string, b: string) =>
    page.evaluate(
      ([a, b]) => {
        const pictures = window as unknown as Record<
          string,
          { rgba: Uint8ClampedArray; alpha: Uint8ClampedArray; width: number }
        >;
        const x = pictures[a];
        const y = pictures[b];
        if (!x || !y) throw new Error("missing picture");
        const width = x.width;
        const height = x.rgba.length / 4 / width;
        const B = 8;
        let blocks = 0;
        let worst = 0;
        for (let by = 0; by + B <= height; by += B)
          for (let bx = 0; bx + B <= width; bx += B) {
            let plant = false;
            const sum = [0, 0, 0, 0, 0, 0];
            for (let j = 0; j < B; j++)
              for (let i = 0; i < B; i++) {
                const o = ((by + j) * width + bx + i) * 4;
                if ((x.alpha[o + 3] ?? 0) > 64 || (y.alpha[o + 3] ?? 0) > 64)
                  plant = true;
                for (let c = 0; c < 3; c++) {
                  sum[c] = (sum[c] ?? 0) + (x.rgba[o + c] ?? 0);
                  sum[c + 3] = (sum[c + 3] ?? 0) + (y.rgba[o + c] ?? 0);
                }
              }
            if (!plant) continue;
            blocks++;
            for (let c = 0; c < 3; c++)
              worst = Math.max(
                worst,
                Math.abs((sum[c] ?? 0) - (sum[c + 3] ?? 0)) / (B * B),
              );
          }
        return { blocks, worst };
      },
      [a, b] as const,
    );

  const cases = ["sunrise", "full-moon", "noon"];
  let before = (await scene.getAttribute("data-sky-light")) ?? "";
  for (const preview of cases) {
    await sky.selectOption(preview);
    await shows(preview, before);
    before = keys[preview] ?? "";
    await capture(`software-${preview}`);
  }
  await drawing.selectOption("gpu");
  await expect(garden).toHaveAttribute("data-tier", "gpu");
  await expect(scene).toHaveAttribute("data-tier", "gpu");
  for (const preview of cases) {
    await sky.selectOption(preview);
    await shows(preview, "");
    await capture(`gpu-${preview}`);
    await page.screenshot({
      path: testInfo.outputPath(`plants-${preview}-gpu.png`),
    });
    const { blocks, worst } = await differs(
      `software-${preview}`,
      `gpu-${preview}`,
    );
    testInfo.annotations.push({
      type: "parity",
      description: `${preview}: ${String(blocks)} plant blocks, worst ${worst.toFixed(1)} levels`,
    });
    expect(blocks).toBeGreaterThan(100);
    expect(worst, preview).toBeLessThan(16);
  }
  await drawing.selectOption("software");
  await sky.selectOption("noon");
  await page.screenshot({
    path: testInfo.outputPath("plants-noon-software.png"),
  });
});

test("Auto leaves a GPU that misses its frame budget for Software; GPU by hand stays", async ({
  page,
}) => {
  // Pass the machine's WebGL off as graphics hardware, so Auto takes the
  // GPU, and make every frame the probe waits for take 45 ms.
  await fakeGpu(page, "Mesa Intel(R) HD Graphics 4000 (IVB GT2)", 45);
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  const drawing = page.getByLabel("Drawing", { exact: true });
  const garden = page.locator(".garden-canvas");
  const scene = page.locator(".landscape-scene");
  await expect(drawing).toHaveValue("auto");
  expect(
    await page.evaluate(() => document.documentElement.dataset.gpu),
  ).toMatch(/^hardware: /);
  // The probe times the first frames, finds them slow, and Auto moves to
  // Software for the visit; the choice itself stays Auto.
  await expect(page.locator("html")).toHaveAttribute(
    "data-gpu-probe",
    /^slow: \d+\.\d ms$/,
  );
  await expect(garden).toHaveAttribute("data-tier", "software");
  await expect(scene).toHaveAttribute("data-tier", "software");
  await expect(garden).toHaveAttribute("data-ready", "true");
  await expect(scene).toHaveAttribute("data-lit", "true");
  await expect(drawing).toHaveValue("auto");
  // GPU chosen by hand is the viewer's call.
  await drawing.selectOption("gpu");
  await expect(garden).toHaveAttribute("data-tier", "gpu");
  await expect(scene).toHaveAttribute("data-tier", "gpu");
  await drawing.selectOption("auto");
  await expect(garden).toHaveAttribute("data-tier", "software");
});

test("loop plays the day round, panels turn dark at night, and the top bar and notes never overlap", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  const app = page.locator(".app");
  const sky = page.getByLabel("Sky", { exact: true });
  const slider = page.getByLabel("Time of day");
  const loop = page.getByLabel("Loop");

  // Night theme follows the shown sky: dark after civil dusk only.
  await sky.selectOption("night");
  await expect(app).toHaveClass(/\bnight\b/);
  await sky.selectOption("noon");
  await expect(app).not.toHaveClass(/\bnight\b/);

  // Loop: 48 minutes a second, wrapping at midnight to the same day.
  await slider.fill(String(23 * 60 + 40));
  await loop.check();
  await expect(sky).toHaveValue("custom");
  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: 5000 })
    .toBeLessThan(120);
  await expect(page.locator(".art-notice")).toContainText("Jun 20, 2024");
  await loop.uncheck();
  const stopped = await slider.inputValue();
  await page.waitForTimeout(500);
  await expect(slider).toHaveValue(stopped);
  // Live stops a loop.
  await loop.check();
  await sky.selectOption("live");
  await expect(loop).not.toBeChecked();

  // A phone on its side: the bar wraps, and the notes sit below it.
  await page.setViewportSize({ width: 915, height: 412 });
  await page.mouse.move(400, 200);
  const bar = await page.locator(".topbar").boundingBox();
  const note = await page.locator(".art-notice").boundingBox();
  expect(bar).not.toBeNull();
  expect(note).not.toBeNull();
  expect(note?.y ?? 0).toBeGreaterThanOrEqual(
    (bar?.y ?? 0) + (bar?.height ?? 0),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(915);
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
