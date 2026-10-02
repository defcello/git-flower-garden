/*
 * P1-E operations: demo mode, diagnostics endpoint, `status`, and `cache`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyInstallNote, main, type Io } from "../../src/cli.ts";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture } from "../../src/demo/builder.ts";
import { gardenTour } from "../../src/demo/fixtures.ts";
import { startDemo } from "../../src/demo/run-demo.ts";
import { startApp } from "../../src/server/app.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        resolve(JSON.parse(body));
      });
    }).on("error", reject);
  });
}

const capture = (): Io & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
  };
};

describe("demo mode", () => {
  it("serves five fictional repositories with a notice, and cleans up", async () => {
    const demo = await startDemo({ port: 0, uiDir: null });
    try {
      const body = (await getJson(`${demo.app.url}api/repositories`)) as {
        display: { notice: string | null; environment: unknown };
        repositories: { id: string; status: { state: string } }[];
      };
      expect(body.display.notice).toMatch(/^Demo mode/);
      // No place configured: the sky over Blacksburg, Virginia.
      expect(body.display.environment).toEqual({
        latitude: 37.2296,
        longitude: -80.4139,
        elevationMeters: 634,
        timeZone: "America/New_York",
        weather: null,
      });
      expect(body.repositories.map((r) => r.id)).toEqual([
        "garden-tour",
        "fork-merge",
        "criss-cross",
        "three-heads",
        "old-branch",
      ]);
      expect(body.repositories.every((r) => r.status.state === "ready")).toBe(
        true,
      );
      const graph = await demo.app.service.graph("garden-tour");
      expect(graph?.graph.nodes.size).toBe(10); // same view as the static probe
    } finally {
      await demo.close();
    }
  });
});

describe("environment", () => {
  it("gives the browser the configured place and zone, and nothing else", async () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 1,
        repositories: [],
        environment: {
          enabled: true,
          latitude: 35.5951,
          longitude: -82.5515,
          timeZone: "America/New_York",
        },
      }),
      await tempDir(),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const app = await startApp(parsed.config, {
      port: 0,
      uiDir: null,
      cacheRoot: await tempDir(),
    });
    try {
      const body = (await getJson(`${app.url}api/repositories`)) as {
        display: { environment: unknown };
      };
      expect(body.display.environment).toEqual({
        latitude: 35.5951,
        longitude: -82.5515,
        elevationMeters: 0,
        timeZone: "America/New_York",
        weather: null,
      });
    } finally {
      await app.close();
    }
  });
});

describe("weather (ADR 0020)", () => {
  it("keeps monitoring and serving when every weather request fails", async () => {
    const dir = await tempDir();
    const fixture = await buildFixture(gardenTour, join(dir, "repo"));
    const parsed = parseConfig(
      JSON.stringify({
        version: 1,
        history: { timeZone: "America/New_York" },
        repositories: [{ id: "tour", path: fixture.dir }],
        environment: { weather: { enabled: true } },
      }),
      dir,
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    let requests = 0;
    const app = await startApp(parsed.config, {
      port: 0,
      uiDir: null,
      cacheRoot: join(dir, "cache"),
      weatherFetch: () => {
        requests += 1;
        return Promise.reject(new TypeError("fetch failed"));
      },
    });
    try {
      await expect.poll(() => requests).toBeGreaterThan(0);
      const body = (await getJson(`${app.url}api/repositories`)) as {
        display: { environment: { weather: unknown } };
        repositories: { status: { state: string } }[];
      };
      expect(body.repositories[0]?.status.state).toBe("ready");
      expect(body.display.environment.weather).toMatchObject({
        state: "unavailable",
        conditions: null,
        diagnostic: "The weather could not be fetched (fetch failed).",
      });
      expect(
        (await app.service.graph("tour"))?.graph.nodes.size,
      ).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe("diagnostics, status, and cache", () => {
  it("reports per-repository diagnostics and manages caches", async () => {
    const dir = await tempDir();
    const fixture = await buildFixture(gardenTour, join(dir, "repo"));
    const cacheRoot = join(dir, "cache");
    const configText = JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories: [{ id: "tour", path: fixture.dir }],
    });
    const parsed = parseConfig(configText, dir);
    if (!parsed.ok) throw new Error("config");
    const app = await startApp(parsed.config, {
      port: 0,
      uiDir: null,
      cacheRoot,
    });
    try {
      await app.service.graph("tour");
      const diag = (await getJson(`${app.url}api/diagnostics`)) as {
        process: { rssBytes: number };
        repositories: {
          id: string;
          counts: { visibleCommits: number };
          timings: { lastReadMs: number; lastGraphMs: number };
        }[];
      };
      expect(diag.process.rssBytes).toBeGreaterThan(0);
      expect(diag.repositories[0]).toMatchObject({
        id: "tour",
        counts: { visibleCommits: expect.any(Number) as unknown },
      });
      expect(diag.repositories[0]?.timings.lastReadMs).toBeGreaterThanOrEqual(
        0,
      );
      expect(diag.repositories[0]?.timings.lastGraphMs).toBeGreaterThanOrEqual(
        0,
      );

      // `status` talks to the running service named by the configuration.
      const port = new URL(app.url).port;
      const configFile = join(dir, "config.json");
      await writeFile(
        configFile,
        JSON.stringify({
          ...(JSON.parse(configText) as object),
          server: { port: Number(port) },
        }),
      );
      const io = capture();
      expect(await main(["status", "--config", configFile], io)).toBe(0);
      expect(io.lines[0]).toMatch(
        /^git-flower-garden at http:\/\/127\.0\.0\.1:\d+\/ · up \d+ s/,
      );
      expect(io.lines[1]).toMatch(
        /^ {2}tour: ready · \d+\/16 commits · read \d+ ms, graph \d+ ms$/,
      );
    } finally {
      await app.close();
    }

    // `status` with nothing running.
    const stopped = capture();
    const configFile = join(dir, "config.json");
    expect(await main(["status", "--config", configFile], stopped)).toBe(1);
    expect(stopped.lines[0]).toMatch(/is not running/);

    // `cache`: list, flag caches not in the configuration, clean one.
    await mkdir(join(cacheRoot, "repositories", "old-project", "objects.git"), {
      recursive: true,
    });
    await writeFile(
      join(cacheRoot, "repositories", "old-project", "objects.git", "pack"),
      "x".repeat(2048),
    );
    const list = capture();
    expect(
      await main(
        ["cache", "--config", configFile, "--cache-dir", cacheRoot],
        list,
      ),
    ).toBe(0);
    expect(list.lines).toContain(
      "  old-project: 0.0 MiB (not in the configuration; remove with --clean)",
    );
    const clean = capture();
    expect(
      await main(
        ["cache", "--cache-dir", cacheRoot, "--clean", "old-project"],
        clean,
      ),
    ).toBe(0);
    expect(clean.lines[0]).toMatch(/^Removed .*old-project$/);
    const missing = capture();
    expect(
      await main(
        ["cache", "--cache-dir", cacheRoot, "--clean", "old-project"],
        missing,
      ),
    ).toBe(1);
  });

  it("prints its version", async () => {
    const io = capture();
    expect(await main(["--version"], io)).toBe(0);
    expect(io.lines[0]).toMatch(/^git-flower-garden \d+\.\d+\.\d+/);
  });
});

describe("upgrading from 0.1 (the npm package git-garden)", () => {
  const install = async (repository: string) => {
    const root = join(await tempDir(), "node_modules");
    const here = join(root, "@defcello", "git-flower-garden", "dist");
    await mkdir(here, { recursive: true });
    await mkdir(join(root, "git-garden"));
    await writeFile(
      join(root, "git-garden", "package.json"),
      JSON.stringify({ name: "git-garden", repository: { url: repository } }),
    );
    return here;
  };

  it("says how to remove the old package and its git-garden command", async () => {
    const here = await install(
      "git+https://github.com/defcello/git-garden.git",
    );
    expect(legacyInstallNote(here)).toMatch(
      /npm uninstall --global git-garden$/,
    );
  });

  it("leaves an unrelated package named git-garden alone", async () => {
    const here = await install("git+https://github.com/someone/git-garden.git");
    expect(legacyInstallNote(here)).toBeNull();
    expect(legacyInstallNote(join(await tempDir(), "a", "b", "c"))).toBeNull();
  });
});
