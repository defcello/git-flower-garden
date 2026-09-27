import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Use a browser that is already installed: Edge ships with Windows; GitHub's
// macOS and Ubuntu runners include Chrome. No browser download is needed.
const channel =
  process.env.GARDEN_E2E_CHANNEL ??
  (process.platform === "win32" ? "msedge" : "chrome");
const port = 4791;

// Shared with the fixture server so tests can change repositories live.
process.env.GARDEN_E2E_ROOT ??= join(
  tmpdir(),
  `git-flower-garden-e2e-${String(process.pid)}`,
);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    channel,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tests/e2e/fixture-server.ts ${String(port)}`,
    url: `http://127.0.0.1:${String(port)}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { GARDEN_E2E_ROOT: process.env.GARDEN_E2E_ROOT },
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 900 } },
      testIgnore: /touch\.spec\.ts$/,
    },
    {
      name: "touch",
      use: { ...devices["Pixel 7"], channel },
      testMatch: /touch\.spec\.ts$/,
    },
  ],
});
