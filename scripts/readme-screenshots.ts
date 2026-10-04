/**
 * The README's garden screenshots: the hillside under each Sky and Weather
 * preview, drawn by the GPU tier (software WebGL headless), without the
 * top bar and notes.
 *
 * Start the demo first (`node src/cli.ts demo`), then:
 *   npm run readme:screenshots [-- <name>]
 */
import { chromium } from "@playwright/test";

const URL = "http://127.0.0.1:4784/";
const OUT = "docs/images";

/** File (under docs/images), Sky preview, Weather preview, and local minutes. */
const SHOTS: readonly [string, string, string, number?][] = [
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
];

const CHROME = ".topbar, [role=note], .art-notice";

const only = process.argv[2];
const browser = await chromium.launch({
  // Headless has no GPU: the GPU tier runs on SwiftShader, chosen by hand.
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  await page.goto(URL);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");
  await page.getByLabel("Drawing", { exact: true }).selectOption("gpu");
  await page.getByLabel("Quality", { exact: true }).selectOption("high");
  for (const [file, sky, weather, minutes] of SHOTS) {
    if (only !== undefined && !file.endsWith(only)) continue;
    await page.getByLabel("Sky", { exact: true }).selectOption(sky);
    await page.getByLabel("Weather", { exact: true }).selectOption(weather);
    if (minutes !== undefined)
      await page
        .getByLabel("Time of day", { exact: true })
        .fill(String(minutes));
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
