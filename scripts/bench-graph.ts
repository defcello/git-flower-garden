/*
 * Long quiet history benchmark (roadmap P1-B): years of linear history, an old
 * side branch, and a handful of recent commits. Shows that the visible graph
 * and layout stay small however long the history, and measures each stage.
 *
 *   npm run bench:graph               # 100k-commit real Git repo + 1M in memory
 *   npm run bench:graph -- --quick    # 10k-commit smoke run
 *
 * Results are recorded in docs/decisions/0010-graph-pipeline-benchmark.md.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { historyWindow } from "../src/core/business-days.ts";
import {
  lanePriority,
  snapshotGraphInput,
} from "../src/core/snapshot-graph.ts";
import {
  buildVisibleGraph,
  type TopologyCommit,
} from "../src/core/visible-graph.ts";
import { readCommitDetails } from "../src/git/commits.ts";
import { readSnapshot } from "../src/git/snapshot.ts";
import { layoutGraph } from "../src/render/layout.ts";
import { renderSvg } from "../src/render/svg.ts";
import {
  buildFixture,
  type FixtureCommit,
  type FixtureSpec,
} from "../src/demo/builder.ts";

const quick = process.argv.includes("--quick");
const NOW = Date.parse("2026-09-22T15:00:00-04:00");
const SETTINGS = {
  businessDays: 2,
  weekdays: ["mon", "tue", "wed", "thu", "fri"] as const,
  timeZone: "America/New_York",
};
const window = historyWindow(
  { ...SETTINGS, weekdays: [...SETTINGS.weekdays] },
  NOW,
);

/** `old` linear commits spread over three years, an old branch, and 5 recent commits. */
function quietSpec(old: number): FixtureSpec {
  const start = Date.parse("2023-09-01T12:00:00Z");
  const step = Math.floor((Date.parse("2026-09-01T12:00:00Z") - start) / old);
  const iso = (ms: number) =>
    new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const commits: FixtureCommit[] = [];
  for (let i = 0; i < old; i++) {
    commits.push({
      name: `c${String(i)}`,
      parents: i === 0 ? [] : [`c${String(i - 1)}`],
      committed: iso(start + i * step),
    });
  }
  const forkAt = `c${String(Math.floor(old / 3))}`;
  commits.push({
    name: "old-branch",
    parents: [forkAt],
    committed: iso(start + Math.floor(old / 3) * step + 1000),
  });
  let prev = `c${String(old - 1)}`;
  for (let r = 0; r < 5; r++) {
    const name = `recent${String(r)}`;
    commits.push({
      name,
      parents: [prev],
      committed: iso(Date.parse("2026-09-21T13:00:00Z") + r * 3_600_000),
    });
    prev = name;
  }
  return {
    description: "quiet",
    commits,
    branches: { main: prev, "archive/old": "old-branch" },
  };
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const result = fn();
  return [result, performance.now() - t0];
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const result = await fn();
  return [result, performance.now() - t0];
}

const ms = (n: number) => n.toFixed(0);
console.log(
  `Node ${process.version}, ${cpus()[0]?.model ?? "?"} x${String(cpus().length)}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB, ${process.platform}`,
);
console.log("| Case | Commits | Stage | ms |");
console.log("| --- | ---: | --- | ---: |");

// 1. Real Git: build a repository, then read it the way the service does.
{
  const old = quick ? 10_000 : 100_000;
  const dir = await mkdtemp(join(tmpdir(), "git-garden-bench-"));
  try {
    const spec = quietSpec(old);
    const total = spec.commits.length;
    const [, buildMs] = await timeAsync(() =>
      buildFixture(spec, join(dir, "repo")),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | (setup) fast-import fixture | ${ms(buildMs)} |`,
    );
    const [snapshot, readMs] = await timeAsync(() =>
      readSnapshot(join(dir, "repo")),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | readSnapshot (refs, worktrees, rev-list topology, re-check) | ${ms(readMs)} |`,
    );
    const [graph, selectMs] = time(() =>
      buildVisibleGraph(snapshotGraphInput(snapshot, window)),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | buildVisibleGraph | ${ms(selectMs)} |`,
    );
    const [layout, layoutMs] = time(() =>
      layoutGraph(graph, { priority: lanePriority(snapshot) }),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | layoutGraph | ${ms(layoutMs)} |`,
    );
    const [details, detailsMs] = await timeAsync(() =>
      readCommitDetails(join(dir, "repo"), [...graph.nodes.keys()]),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | readCommitDetails (visible only) | ${ms(detailsMs)} |`,
    );
    const [svg, svgMs] = time(() =>
      renderSvg(graph, layout, {
        subjects: new Map([...details].map(([o, d]) => [o, d.subject])),
      }),
    );
    console.log(
      `| real Git | ${total.toLocaleString("en-US")} | renderSvg | ${ms(svgMs)} |`,
    );
    console.log(
      `\nReal Git result: ${String(graph.nodes.size)} visible of ${String(graph.reachableCount)} reachable; ${String(layout.rows)} rows, ${String(layout.lanes)} lanes, ${String(layout.height)} px tall; SVG ${String(svg.length)} bytes; collapsed edges: ${graph.edges
        .filter((e) => e.kind === "collapsed")
        .map((e) => String(e.hidden))
        .join(
          ", ",
        )}; tails: ${graph.tails.map((t) => String(t.hidden)).join(", ")}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

// 2. In memory at a million commits: selection and layout only.
{
  const old = quick ? 50_000 : 1_000_000;
  const spec = quietSpec(old);
  const commits = new Map<string, TopologyCommit>(
    spec.commits.map((c) => [
      c.name,
      {
        parents: c.parents ?? [],
        committerTime: Date.parse(c.committed) / 1000,
      },
    ]),
  );
  const heads = Object.entries(spec.branches).map(([name, target]) => ({
    id: name,
    commitOid: target,
  }));
  const [graph, selectMs] = time(() =>
    buildVisibleGraph({ commits, heads, window }),
  );
  const [layout, layoutMs] = time(() => layoutGraph(graph));
  console.log("| Case | Commits | Stage | ms |");
  console.log("| --- | ---: | --- | ---: |");
  console.log(
    `| in memory | ${commits.size.toLocaleString("en-US")} | buildVisibleGraph | ${ms(selectMs)} |`,
  );
  console.log(
    `| in memory | ${commits.size.toLocaleString("en-US")} | layoutGraph | ${ms(layoutMs)} |`,
  );
  console.log(
    `\nIn-memory result: ${String(graph.nodes.size)} visible of ${String(graph.reachableCount)}; ${String(layout.rows)} rows, ${String(layout.height)} px tall`,
  );
}
