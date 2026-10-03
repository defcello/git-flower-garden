import { describe, expect, it } from "vitest";
import type {
  GraphJson,
  GraphNodeJson,
  RepositoriesJson,
  RepositoryStatusJson,
  SourceState,
} from "../../src/api/types.ts";
import type { GardenSnapshot } from "../../src/ui/model/snapshot.ts";
import {
  featuredCommit,
  FRAME,
  nodeAt,
  pixelFrame,
} from "../../src/ui/renderers/pixel/pixel-art.ts";
import { gardenView } from "../../src/ui/viewmodel/garden.ts";

const status = (
  id: string,
  state: SourceState,
  commits: number | null,
  remote: "ok" | "error" | null = null,
): RepositoryStatusJson => ({
  id,
  label: id.toUpperCase(),
  kind: "local",
  revision: 1,
  status: { state, lastAttempt: 0, lastSuccess: 0, diagnostic: null },
  remote:
    remote === null
      ? null
      : {
          state: remote,
          lastAttempt: 0,
          lastSuccess: 0,
          nextAttempt: null,
          diagnostic: null,
          lastEvent: null,
        },
  counts:
    commits === null
      ? null
      : { refs: 1, worktrees: 0, reachableCommits: commits },
});

const node = (
  oid: string,
  row: number,
  reasons: GraphNodeJson["reasons"],
  refs: string[] = [],
): GraphNodeJson => ({
  oid,
  lane: 0,
  row,
  x: 0,
  y: 0,
  reasons,
  anchorFor: [],
  futureDated: false,
  boundary: false,
  refs,
  subject: `subject ${oid}`,
  message: oid,
  parents: [],
  author: null,
  committer: null,
  worktrees: [],
});

const graph = (id: string): GraphJson => ({
  id,
  revision: 1,
  window: { startMs: 0, endMs: 0, businessDates: [], timeZone: "UTC" },
  reachableCount: 3,
  completeness: {
    coherent: true,
    attempts: 1,
    shallow: false,
    grafts: false,
    missingTips: [],
  },
  revealed: [],
  nodes: [
    node("c1", 0, ["recent"]),
    node("c2", 1, ["recent"], ["tag: v1"]),
    node("c3", 2, ["head"], ["main"]),
  ],
  edges: [
    {
      child: "c3",
      parent: "c2",
      kind: "direct",
      hidden: null,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
    },
    {
      child: "c2",
      parent: "c1",
      kind: "direct",
      hidden: null,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
    },
  ],
  tails: [],
  size: { width: 20, height: 60, lanes: 1, rows: 3 },
});

function snapshot(repos: RepositoryStatusJson[]): GardenSnapshot {
  const repositories = {
    apiVersion: 1,
    display: {
      timeZone: "UTC",
      businessDays: 2,
      reducedMotion: false,
      windowStartMs: 0,
      notice: null,
      environment: null,
    },
    repositories: repos,
    configErrors: [],
    restartNeeded: [],
    webhooks: { state: "off", url: null, diagnostic: null, lastEvent: null },
  } satisfies RepositoriesJson;
  return {
    repositories,
    graphs: new Map(
      repos
        .filter((r) => (r.counts?.reachableCommits ?? 0) > 0)
        .map((r) => [r.id, graph(r.id)]),
    ),
    fetchedAt: 5,
    connectionError: null,
  };
}

describe("garden view model", () => {
  it("is loading before the first status and empty with nothing configured", () => {
    expect(
      gardenView({
        repositories: null,
        graphs: new Map(),
        fetchedAt: 0,
        connectionError: null,
      }).phase,
    ).toBe("loading");
    expect(gardenView(snapshot([])).phase).toBe("empty");
  });

  it("derives each repository's health once, in configuration order", () => {
    const view = gardenView(
      snapshot([
        status("ok", "ready", 3),
        status("old", "stale", 3),
        status("bare", "ready", 0),
        status("far", "ready", 3, "error"),
        status("bad", "error", null),
      ]),
    );
    expect(view.phase).toBe("ready");
    expect(
      view.repositories.map((r) => [
        r.id,
        r.index,
        r.drawable,
        r.health.wilting,
        r.health.empty,
        r.health.marker,
      ]),
    ).toEqual([
      ["ok", 0, true, false, false, null],
      ["old", 1, true, true, false, "◷"],
      ["bare", 2, false, false, true, null],
      ["far", 3, true, false, false, "⊘"],
      ["bad", 4, false, false, false, "✕"],
    ]);
    expect(view.now).toBe(5);
  });
});

describe("pixel renderer", () => {
  const view = gardenView(
    snapshot([
      status("a", "ready", 3),
      status("b", "stale", 3),
      status("c", "ready", 0),
    ]),
  );

  it("draws a full, opaque frame deterministically", () => {
    const frame = pixelFrame(view, null);
    expect(frame.width).toBe(FRAME.width);
    expect(frame.pixels.length).toBe(FRAME.width * FRAME.height * 4);
    for (let i = 3; i < frame.pixels.length; i += 4)
      expect(frame.pixels[i]).toBe(255);
    expect(pixelFrame(view, null).pixels).toEqual(frame.pixels);
  });

  it("places every repository, and maps its commits back for hit testing", () => {
    const frame = pixelFrame(view, null);
    expect(frame.plants.map((p) => p.repo.id)).toEqual(["a", "b", "c"]);
    const [a, , c] = frame.plants;
    expect(a?.nodes.map((n) => n.node.oid)).toEqual(["c1", "c2", "c3"]);
    expect(c?.nodes).toEqual([]);
    // Newer commits stand higher.
    const y = (oid: string) => a?.nodes.find((n) => n.node.oid === oid)?.y;
    expect(y("c3")).toBeLessThan(y("c1") ?? 0);
    const head = a?.nodes.find((n) => n.node.oid === "c3");
    expect(head && nodeAt(frame, head.x, head.y)?.node.oid).toBe("c3");
    expect(nodeAt(frame, -10, -10)).toBeNull();
    expect(a && featuredCommit(a)?.oid).toBe("c3");
  });

  it("greys a wilting plant", () => {
    const frame = pixelFrame(view, null);
    const at = (x: number, y: number) => {
      const i = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(i, i + 3)];
    };
    const head = (id: string) => {
      const n = frame.plants
        .find((p) => p.repo.id === id)
        ?.nodes.find((m) => m.node.oid === "c3");
      return n ? at(n.x - 1, n.y) : [];
    };
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(spread(head("b"))).toBeLessThan(spread(head("a")));
  });
});
