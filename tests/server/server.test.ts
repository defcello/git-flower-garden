import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type Io } from "../../src/cli.ts";
import { parseConfig, type Config } from "../../src/config/config.ts";
import { defaultCacheDir, defaultConfigPath } from "../../src/config/paths.ts";
import { RepositoryService } from "../../src/monitor/repository-service.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { buildFixture, fixtureGit } from "../fixtures/builder.ts";
import { gardenTour } from "../fixtures/demo.ts";
import { snapshotTree } from "../helpers/snapshot.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

function configFor(repositories: unknown[], dir: string): Config {
  const result = parseConfig(
    JSON.stringify({
      version: 1,
      history: { timeZone: "America/New_York" },
      repositories,
    }),
    dir,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let root: string;
let server: StartedServer;
let tourDir: string;

beforeAll(async () => {
  root = await tempDir();
  // A path with spaces and non-ASCII characters.
  tourDir = join(root, "jardín de rosas", "tour");
  await mkdir(join(root, "jardín de rosas"), { recursive: true });
  await buildFixture(gardenTour, tourDir);
  const empty = join(root, "empty repo");
  await fixtureGit(root, ["init", "--quiet", empty]);
  const config = configFor(
    [
      { id: "tour", label: "Garden <tour>", path: tourDir },
      { id: "empty", path: empty },
      { id: "missing", path: join(root, "nowhere") },
      { id: "not-git", path: root },
      { id: "remote", url: "https://example.invalid/r.git" },
    ],
    root,
  );
  // Pin the clock: Tuesday 2026-09-22 15:00 EDT, as in the static probe.
  const service = new RepositoryService(config, {
    now: () => Date.parse("2026-09-22T15:00:00-04:00"),
  });
  await service.refreshAll();
  server = await startServer(service, "127.0.0.1", 0);
});

afterAll(async () => {
  await server.close();
});

describe("loopback server", () => {
  it("reports every source with an isolated status", async () => {
    const reply = await get(`${server.url}api/repositories`);
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as {
      repositories: {
        id: string;
        status: { state: string; diagnostic: string | null };
        counts: unknown;
      }[];
    };
    const byId = Object.fromEntries(body.repositories.map((r) => [r.id, r]));
    expect(byId.tour?.status.state).toBe("ready");
    expect(byId.empty?.status.state).toBe("ready");
    expect(byId.empty?.counts).toEqual({
      refs: 0,
      worktrees: 1,
      reachableCommits: 0,
    });
    expect(byId.missing?.status).toMatchObject({
      state: "error",
      diagnostic: expect.stringMatching(/^Path not found/) as unknown,
    });
    expect(byId["not-git"]?.status).toMatchObject({
      state: "error",
      diagnostic: expect.stringMatching(/Not a Git repository/i) as unknown,
    });
    // Without background monitoring nothing has been fetched yet.
    expect(byId.remote?.status).toMatchObject({
      state: "initializing",
      diagnostic: "Waiting for the first fetch from the remote.",
    });
  });

  it("serves the visible graph as JSON and escaped SVG", async () => {
    const json = JSON.parse(
      (await get(`${server.url}api/repositories/tour/graph`)).body,
    ) as {
      nodes: { subject: string; refs: string[]; reasons: string[] }[];
      edges: { kind: string; hidden: number | null }[];
    };
    expect(json.nodes).toHaveLength(10);
    expect(json.nodes.find((n) => n.refs.includes("tag: v1.0"))?.subject).toBe(
      "Merge branch 'trellis'",
    );
    expect(
      json.edges
        .filter((e) => e.kind === "collapsed")
        .map((e) => e.hidden)
        .sort(),
    ).toEqual([1, 4]);

    const svg = await get(`${server.url}api/repositories/tour/graph.svg`);
    expect(svg.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(svg.body).toContain("Plant &lt;basil&gt; &amp; &quot;thyme&quot;");
    expect(svg.body).not.toContain("<basil>");

    const page = await get(server.url);
    expect(page.body).toContain("Garden &lt;tour&gt;");
    expect(page.body).toContain('src="/api/repositories/tour/graph.svg');
  });

  it("finds old tags and temporarily reveals their commits with connecting context", async () => {
    const tags = JSON.parse(
      (await get(`${server.url}api/repositories/tour/tags?q=V0`)).body,
    ) as {
      tags: { shortName: string; commitOid: string }[];
    };
    expect(tags.tags.map((t) => t.shortName)).toEqual(["v0.9"]);
    const oldOid = tags.tags[0]?.commitOid as string;

    type Graph = {
      revealed: string[];
      completeness: { coherent: boolean };
      nodes: { oid: string; reasons: string[]; subject: string }[];
      edges: {
        child: string;
        parent: string;
        kind: string;
        hidden: number | null;
      }[];
    };
    const plain = JSON.parse(
      (await get(`${server.url}api/repositories/tour/graph`)).body,
    ) as Graph;
    expect(plain.nodes.some((n) => n.oid === oldOid)).toBe(false);
    expect(plain.completeness.coherent).toBe(true);

    const revealed = JSON.parse(
      (
        await get(
          `${server.url}api/repositories/tour/graph?reveal=${oldOid},not-an-oid`,
        )
      ).body,
    ) as Graph;
    expect(revealed.revealed).toEqual([oldOid]);
    const node = revealed.nodes.find((n) => n.oid === oldOid);
    expect(node).toMatchObject({
      reasons: ["inspection"],
      subject: "Edge the lawn",
    });
    // The 4-commit compressed run is now split around the revealed commit.
    const collapsed = revealed.edges
      .filter((e) => e.kind === "collapsed")
      .map((e) => e.hidden)
      .sort();
    expect(collapsed).toEqual([1, 1, 2]);
  });

  it("answers an empty repository with an empty graph, not an error", async () => {
    const reply = await get(`${server.url}api/repositories/empty/graph`);
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.body) as { nodes: unknown[] }).nodes).toEqual([]);
  });

  it("refuses foreign Host headers, cross-origin requests, and non-GET methods", async () => {
    const port = new URL(server.url).port;
    expect(
      (
        await get(`${server.url}api/repositories`, {
          Host: `evil.example:${port}`,
        })
      ).status,
    ).toBe(421);
    expect(
      (await get(`${server.url}api/repositories`, { Host: "127.0.0.1:1" }))
        .status,
    ).toBe(421);
    expect(
      (
        await get(`${server.url}api/repositories`, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await get(`${server.url}api/repositories`, {
          Origin: `http://127.0.0.1:${port}`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await get(`${server.url}api/repositories`, {
          Host: `localhost:${port}`,
        })
      ).status,
    ).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(
        (await get(`${server.url}api/repositories`, {}, method)).status,
      ).toBe(405);
    }
    const reply = await get(`${server.url}api/health`);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(reply.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(reply.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("returns 404 for unknown repositories and routes, including traversal attempts", async () => {
    expect((await get(`${server.url}api/repositories/nope/graph`)).status).toBe(
      404,
    );
    expect(
      (await get(`${server.url}api/repositories/..%2F..%2Fetc/graph`)).status,
    ).toBe(404);
    expect((await get(`${server.url}etc/passwd`)).status).toBe(404);
  });

  it("never modifies the monitored repository", async () => {
    const before = await snapshotTree(tourDir);
    await get(`${server.url}api/repositories/tour/graph`);
    await get(`${server.url}api/repositories/tour/graph.svg`);
    expect(await snapshotTree(tourDir)).toEqual(before);
  });
});

describe("zero configured repositories", () => {
  it("shows a welcome page instead of failing", async () => {
    const service = new RepositoryService(configFor([], root));
    const s = await startServer(service, "127.0.0.1", 0);
    try {
      const page = await get(s.url);
      expect(page.status).toBe(200);
      expect(page.body).toContain("No repositories are configured yet");
    } finally {
      await s.close();
    }
  });
});

describe("CLI", () => {
  const capture = (): Io & { lines: string[] } => {
    const lines: string[] = [];
    return {
      lines,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    };
  };

  it("init-config writes a valid starter file and refuses to overwrite", async () => {
    const file = join(await tempDir(), "nested", "config.json");
    const io = capture();
    expect(await main(["init-config", "--config", file], io)).toBe(0);
    expect(await main(["validate-config", "--config", file], io)).toBe(0);
    expect(await main(["init-config", "--config", file], io)).toBe(1);
    expect(io.lines.at(-1)).toMatch(/already exists; it was left unchanged/);
  });

  it("validate-config reports located errors and duplicate repositories", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    await writeFile(
      file,
      '{\n  "version": 1,\n  "repositories": [{ "id": "a", "path": "missing", "bogus": 1 }]\n}\n',
    );
    let io = capture();
    expect(await main(["validate-config", "--config", file], io)).toBe(1);
    expect(io.lines[0]).toBe(
      `ERR ${file}:3:52: /repositories/0/bogus unknown key "bogus"; allowed: id, label, path, url, remotes`,
    );

    // Two entries for one repository: the main checkout and one of its worktrees.
    await fixtureGit(tourDir, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      join(dir, "linked"),
    ]);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repositories: [
          { id: "main", path: tourDir },
          { id: "linked", path: "linked" },
          { id: "gone", path: "gone" },
          {
            id: "remote-typo",
            path: tourDir.replace("tour", "tour"),
            remotes: ["upstream"],
          },
        ],
      }),
    );
    io = capture();
    expect(await main(["validate-config", "--config", file], io)).toBe(1);
    expect(io.lines.filter((l) => l.startsWith("ERR"))).toEqual([
      expect.stringMatching(
        /repository "linked": same repository as "main"/,
      ) as unknown,
      `ERR ${file}: repository "gone": path not found: ${join(dir, "gone")}`,
      expect.stringMatching(
        /repository "remote-typo": same repository as "main"/,
      ) as unknown,
      `ERR ${file}: repository "remote-typo": remote "upstream" is not configured in this repository`,
      "ERR 4 problem(s) found.",
    ]);
  });

  it("rejects unknown commands and arguments with usage", async () => {
    const io = capture();
    expect(await main(["plant"], io)).toBe(2);
    expect(await main(["serve", "extra"], io)).toBe(2);
    expect(await main(["--bogus"], io)).toBe(2);
    expect(await main(["--help"], io)).toBe(0);
  });

  it("explains a port already in use", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    const port = new URL(server.url).port;
    await writeFile(file, JSON.stringify({ version: 1, repositories: [] }));
    const io = capture();
    expect(await main(["serve", "--config", file, "--port", port], io)).toBe(1);
    expect(io.lines.at(-1)).toMatch(
      new RegExp(`Port ${port} on 127\\.0\\.0\\.1 is already in use`),
    );
  });
});

describe("per-user paths", () => {
  it.each([
    [
      "win32",
      { APPDATA: "A", LOCALAPPDATA: "L", USERPROFILE: "U" },
      join("A", "git-garden", "config.json"),
      join("L", "git-garden", "Cache"),
    ],
    [
      "darwin",
      { HOME: "H" },
      join("H", "Library", "Application Support", "git-garden", "config.json"),
      join("H", "Library", "Caches", "git-garden"),
    ],
    [
      "linux",
      { HOME: "H" },
      join("H", ".config", "git-garden", "config.json"),
      join("H", ".cache", "git-garden"),
    ],
    [
      "linux",
      { HOME: "H", XDG_CONFIG_HOME: "X", XDG_CACHE_HOME: "C" },
      join("X", "git-garden", "config.json"),
      join("C", "git-garden"),
    ],
  ] as const)("%s %j", (platform, env, config, cache) => {
    expect(defaultConfigPath(env, platform)).toBe(config);
    expect(defaultCacheDir(env, platform)).toBe(cache);
  });
});
