/*
 * Weather in the garden view (ADR 0018 step 5, ADR 0020):
 * - live weather comes from the service (here a stand-in for MET Norway)
 *   and is shown as a model forecast, with its source and credit, and
 *   drawn: clouds in the sky, rain over the hillside;
 * - developer previews are labelled as previews, never as live weather;
 * - both tiers draw the same clouds and light, the GPU tier with more
 *   particles; a rainbow appears only for sunlit rain, and is labelled
 *   as inferred from the forecast.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture } from "../../src/demo/builder.ts";
import { artProof } from "../../src/demo/fixtures.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";
import { PARTICLE_CAPS } from "../../src/environment/weather-effects.ts";
import { metDocument } from "../helpers/met-norway.ts";

let app: RunningApp;
let root: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = await mkdtemp(join(tmpdir(), "git-flower-garden-weather-"));
  await buildFixture(artProof, join(root, "tour"));
  const parsed = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: [{ id: "tour", path: "tour" }],
      environment: { weather: { enabled: true } },
    }),
    root,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  // Heavy rain for the hours around now, whenever the test runs.
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const document = metDocument(
    [-1, 0, 1, 2].map((i) => ({
      time: new Date(hour + i * 3_600_000).toISOString(),
      symbol: "heavyrain",
      millimeters: 6,
      cloud: 100,
      temperature: 11,
    })),
  );
  app = await startApp(parsed.config, {
    port: 0,
    cacheRoot: join(root, ".cache"),
    weatherFetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(document), {
          status: 200,
          headers: { expires: new Date(Date.now() + 1_800_000).toUTCString() },
        }),
      ),
  });
});

test.afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test.use({ viewport: { width: 1920, height: 1080 } });

async function openGarden(page: Page) {
  await page.goto(app.url);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await expect(page.locator(".garden-scene [data-plot]")).toHaveCount(1);
}

/** Mean brightness and colorfulness (max - min channel) of a scene region. */
async function region(
  page: Page,
  box: readonly [number, number, number, number],
): Promise<{ light: number; color: number }> {
  return page
    .locator(".landscape-scene:not([hidden])")
    .evaluate((node, [x, y, w, h]) => {
      const scene = node as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = scene.width;
      copy.height = scene.height;
      const g = copy.getContext("2d");
      if (!g) return { light: NaN, color: NaN };
      g.drawImage(scene, 0, 0);
      const data = g.getImageData(
        Math.round(x * copy.width),
        Math.round(y * copy.height),
        Math.max(1, Math.round(w * copy.width)),
        Math.max(1, Math.round(h * copy.height)),
      ).data;
      let light = 0;
      let color = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0;
        const gr = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        light += (r + gr + b) / 3;
        color += Math.max(r, gr, b) - Math.min(r, gr, b);
      }
      const n = data.length / 4;
      return { light: light / n, color: color / n };
    }, box);
}

/** Wait until the scene shows the requested light, lit whole and settled. */
async function settled(page: Page) {
  const scene = page.locator(".landscape-scene:not([hidden])");
  await expect(scene).toHaveAttribute("data-lit", "true");
  await expect
    .poll(() =>
      scene.evaluate(
        (node) =>
          node.dataset.tier === "gpu" ||
          node.dataset.skyLight === node.dataset.artLight,
      ),
    )
    .toBe(true);
}

test("live weather is drawn and described as a model forecast with its source", async ({
  page,
}) => {
  await openGarden(page);
  const note = page.locator(".art-notice");
  await expect(note.locator(".weather-note")).toContainText(
    /Forecast \d\d:\d\d–\d\d:\d\d: heavy rain, 11 °C/,
  );
  await expect(note).toContainText("a model forecast, not observed");
  await expect(note.locator(".weather-credit")).toHaveText(
    "Weather data from MET Norway (Norwegian Meteorological Institute), CC BY 4.0",
  );
  await expect(note).not.toContainText("Weather preview");
  await expect(page.getByLabel("Weather", { exact: true })).toHaveValue("live");
  await expect(page.locator(".landscape-scene")).toHaveAttribute(
    "data-clouds",
    "true",
  );
  await expect(page.locator(".weather-overlay")).toHaveAttribute(
    "data-precipitation",
    "rain",
  );
  // A chosen time is not described by this hour's forecast: no weather.
  await page.getByLabel("Sky", { exact: true }).selectOption("noon");
  await expect(note.locator(".weather-note")).toHaveCount(0);
  await expect(page.locator(".weather-overlay")).toHaveCount(0);
});

test("weather previews are labelled, and both tiers draw the same clouds and light", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await openGarden(page);
  const drawing = page.getByLabel("Drawing", { exact: true });
  const weather = page.getByLabel("Weather", { exact: true });
  const sky = page.getByLabel("Sky", { exact: true });
  const note = page.locator(".art-notice");
  const scene = page.locator(".landscape-scene:not([hidden])");
  await drawing.selectOption("software");
  await expect(scene).toHaveAttribute("data-tier", "software");
  await sky.selectOption("noon");

  // Sky high in the frame, and the near hill.
  const SKY = [0.3, 0.04, 0.4, 0.08] as const;
  const HILL = [0.45, 0.72, 0.1, 0.05] as const;
  const shot = async (name: string) => {
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    return { sky: await region(page, SKY), hill: await region(page, HILL) };
  };

  await weather.selectOption("clear");
  await expect(note).toContainText("Weather preview");
  await expect(note).toContainText("not live weather: Clear");
  await expect(page.locator(".weather-overlay")).toHaveCount(0);
  const clear = await shot("clear-software");

  await weather.selectOption("heavy-rain");
  await expect(note).toContainText("not live weather: Heavy rain");
  const fall = page.locator(".weather-fall");
  // High quality, the default, keeps Software's caps.
  await expect(fall).toHaveAttribute(
    "data-particles",
    String(PARTICLE_CAPS.software.rain),
  );
  const rain = await shot("heavy-rain-software");
  // Overcast: the blue goes out of the sky, and the hill loses the Sun.
  expect(rain.sky.color).toBeLessThan(clear.sky.color * 0.5);
  expect(rain.hill.light).toBeLessThan(clear.hill.light);

  await drawing.selectOption("gpu");
  await expect(scene).toHaveAttribute("data-tier", "gpu");
  await expect(fall).toHaveAttribute("data-tier", "gpu");
  // High adds half again on the GPU; Low halves the caps.
  await expect(fall).toHaveAttribute(
    "data-particles",
    String(PARTICLE_CAPS.gpu.rain * 1.5),
  );
  const quality = page.getByLabel("Quality", { exact: true });
  await quality.selectOption("low");
  await expect(fall).toHaveAttribute(
    "data-particles",
    String(PARTICLE_CAPS.gpu.rain / 2),
  );
  await quality.selectOption("balanced");
  await expect(fall).toHaveAttribute(
    "data-particles",
    String(PARTICLE_CAPS.gpu.rain),
  );
  const gpu = await shot("heavy-rain-gpu");
  for (const part of ["sky", "hill"] as const)
    expect(
      Math.abs(gpu[part].light - rain[part].light),
      `${part}: GPU ${gpu[part].light.toFixed(1)}, software ${rain[part].light.toFixed(1)}`,
    ).toBeLessThan(8);

  // Sunlit rain brings a rainbow, said to be inferred, not observed.
  await sky.selectOption("sunset");
  await weather.selectOption("showers");
  await expect(scene).toHaveAttribute("data-rainbow", "true");
  await expect(note).toContainText("optics of sunlit rain");
  await shot("showers-sunset-gpu");
  await sky.selectOption("noon");
  await expect(scene).toHaveAttribute("data-rainbow", "false");
  await expect(note).not.toContainText("optics of sunlit rain");

  // Snow falls in both tiers.
  await weather.selectOption("snow");
  await expect(page.locator(".weather-overlay")).toHaveAttribute(
    "data-precipitation",
    "snow",
  );
  await drawing.selectOption("software");
  await expect(fall).toHaveAttribute("data-tier", "software");
  await shot("snow-software");

  await weather.selectOption("live");
  await expect(note).not.toContainText("Weather preview");
});
