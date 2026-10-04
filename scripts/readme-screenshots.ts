/**
 * The README's garden screenshots: the hillside under each Sky and Weather
 * preview, drawn by the GPU tier on real graphics hardware, without the
 * top bar and notes. Chromium runs headed: headless has only SwiftShader,
 * which the garden treats as software and gives the Software tier's grass.
 *
 * Start the demo first (`node src/cli.ts demo`), then, with a display:
 *   npm run readme:screenshots [-- <name>]
 */
import { chromium } from "@playwright/test";

const URL = "http://127.0.0.1:4784/";
const OUT = "docs/images";

interface Wind {
  from: string;
  speedMph: number;
  gustMph: number;
}

/**
 * File (under docs/images), Sky preview, Weather preview, local minutes,
 * and a Wind preview (else the weather's own wind).
 */
const SHOTS: readonly [string, string, string, (number | undefined)?, Wind?][] =
  [
    ["garden-view", "noon", "partly-cloudy"],
    ["scenes/sunrise", "sunrise", "clear"],
    // Mid-afternoon on the Sunset preview's day: a high, colourful bow.
    ["scenes/rainbow", "sunset", "showers", 18 * 60 + 30],
    ["scenes/sunset", "sunset", "partly-cloudy"],
    ["scenes/civil-dusk", "civil-dusk", "clear"],
    ["scenes/full-moon", "full-moon", "clear"],
    ["scenes/daytime-moon", "daytime-moon", "clear"],
    ["scenes/thunderstorm", "noon", "thunderstorm"],
    ["scenes/snow", "noon", "snow"],
    ["scenes/fog", "sunrise", "fog"],
    ["scenes/solar-eclipse-total", "solar-eclipse-total", "clear"],
    ["scenes/lunar-eclipse-total", "lunar-eclipse-total", "clear"],
    ["scenes/polar-day", "polar-day", "clear"],
    // A gale from the west, gusting: the grass leans right, swept by waves.
    [
      "scenes/high-wind",
      "noon",
      "partly-cloudy",
      undefined,
      { from: "W", speedMph: 50, gustMph: 60 },
    ],
  ];

const CHROME = ".topbar, [role=note], .art-notice";

const only = process.argv[2];
const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  await page.goto(URL);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.getByLabel("Drawing", { exact: true }).selectOption("gpu");
  await page.getByLabel("Quality", { exact: true }).selectOption("high");
  const gpu = await page.locator("html").getAttribute("data-gpu");
  if (!gpu?.startsWith("hardware"))
    throw new Error(`No hardware WebGL (${String(gpu)}): run with a display`);
  console.log(gpu);
  for (const [file, sky, weather, minutes, wind] of SHOTS) {
    if (only !== undefined && !file.endsWith(only)) continue;
    await page.getByLabel("Sky", { exact: true }).selectOption(sky);
    await page.getByLabel("Weather", { exact: true }).selectOption(weather);
    if (minutes !== undefined)
      await page
        .getByLabel("Time of day", { exact: true })
        .fill(String(minutes));
    const direction = page.getByLabel("Wind direction", { exact: true });
    await direction.selectOption(wind?.from ?? "weather");
    if (wind) {
      await page
        .getByLabel("Wind speed", { exact: true })
        .fill(String(wind.speedMph));
      await page
        .getByLabel("Gust strength", { exact: true })
        .fill(String(wind.gustMph));
    }
    // Relit, and the clouds and particles under way.
    await page.waitForTimeout(6000);
    // The page's CSP refuses injected style sheets: hide them one by one.
    const hide = (hidden: boolean) =>
      page.locator(CHROME).evaluateAll((elements, hidden) => {
        for (const element of elements as unknown as {
          style: { visibility: string };
        }[])
          element.style.visibility = hidden ? "hidden" : "";
      }, hidden);
    await hide(true);
    await page.screenshot({
      path: `${OUT}/${file}.jpg`,
      type: "jpeg",
      quality: 85,
    });
    await hide(false);
    console.log(file);
  }
} finally {
  await browser.close();
}
