import { describe, expect, it } from "vitest";
import {
  buildVisibleGraph,
  type TopologyCommit,
  type VisibleGraph,
} from "../../src/core/visible-graph.ts";
import { layoutGraph } from "../../src/render/layout.ts";
import { escapeXml, renderSvg } from "../../src/render/svg.ts";
import { randomDag, seededRandom } from "../oracle/random-dag.ts";

function randomGraph(seed: number): VisibleGraph {
  const random = seededRandom(seed + 1);
  const dag = randomDag(seed, {
    commits: 5 + (seed % 40),
    heads: 1 + (seed % 6),
    mergeChance: 0.3,
    reach: 6,
  });
  const commits = new Map<string, TopologyCommit>();
  // Deliberately skewed clocks: timestamps unrelated to topology.
  dag.names.forEach((name) =>
    commits.set(name, {
      parents: dag.parents.get(name) ?? [],
      committerTime: Math.floor(random() * 1_000_000),
    }),
  );
  return buildVisibleGraph({
    commits,
    heads: dag.heads.map((h, i) => ({ id: `h${String(i)}`, commitOid: h })),
    window: {
      startMs: 700_000_000,
      endMs: 1_000_000_000,
      businessDates: [],
      timeZone: "UTC",
    },
  });
}

/** Same graph with every map and array rebuilt in a shuffled order. */
function shuffled(graph: VisibleGraph, seed: number): VisibleGraph {
  const random = seededRandom(seed);
  const shuffle = <T>(xs: T[]): T[] =>
    xs
      .map((x) => [random(), x] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x);
  return {
    ...graph,
    nodes: new Map(shuffle([...graph.nodes])),
    edges: shuffle([...graph.edges]),
    tails: shuffle([...graph.tails]),
  };
}

describe("layoutGraph properties on 400 random graphs with skewed clocks", () => {
  it("unique positions, parents strictly lower, clear first-parent lanes, deterministic", () => {
    let sameLaneEdges = 0;
    let detours = 0;
    for (let seed = 0; seed < 400; seed++) {
      const graph = randomGraph(seed);
      const layout = layoutGraph(graph);
      const positions = new Set<string>();
      for (const n of layout.nodes.values()) {
        const key = `${String(n.lane)},${String(n.row)}`;
        expect(
          positions.has(key),
          `seed ${String(seed)} duplicate ${key}`,
        ).toBe(false);
        positions.add(key);
      }
      expect(layout.nodes.size).toBe(graph.nodes.size);
      for (const e of layout.edges) {
        const child = layout.nodes.get(e.child);
        const parent = layout.nodes.get(e.parent);
        expect(
          (parent?.row ?? 0) < (child?.row ?? 0),
          `seed ${String(seed)} ${e.child}->${e.parent}`,
        ).toBe(true);
        if (
          child &&
          parent &&
          child.lane === parent.lane &&
          e.detour === undefined
        ) {
          sameLaneEdges++;
          // A straight vertical edge must not pass through another commit.
          for (const other of layout.nodes.values()) {
            const inside =
              other.lane === child.lane &&
              other.row > parent.row &&
              other.row < child.row;
            expect(
              inside,
              `seed ${String(seed)}: ${other.oid} on ${e.child}->${e.parent}`,
            ).toBe(false);
          }
        }
      }
      detours += layout.edges.filter((e) => e.detour !== undefined).length;
      expect(layoutGraph(shuffled(graph, seed))).toEqual(layout);
    }
    expect(sameLaneEdges).toBeGreaterThan(1000);
    // First-parent edges get a reserved lane, so detours stay the exception
    // even on these merge-heavy graphs (about 8% observed; 20% is a
    // readability guard, not a correctness property).
    expect(detours).toBeGreaterThan(0);
    expect(detours).toBeLessThan(sameLaneEdges / 5);
  });
});

describe("renderSvg", () => {
  it("escapes repository text and renders every visible commit", () => {
    const graph = randomGraph(3);
    const layout = layoutGraph(graph);
    const hostile = `</text><script>alert("x")</script> & 'quoted'`;
    const first = [...graph.nodes.keys()][0] as string;
    const svg = renderSvg(graph, layout, {
      title: hostile,
      refs: new Map([[first, [hostile]]]),
      subjects: new Map([[first, hostile]]),
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain(escapeXml(hostile));
    for (const oid of graph.nodes.keys())
      expect(svg).toContain(`data-oid="${oid}"`);
    expect(svg.match(/<path class="edge /g)?.length).toBe(graph.edges.length);
  });

  it("escapes all five XML special characters", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;",
    );
  });
});
