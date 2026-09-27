/*
 * End-to-end static render: build a demo fixture as a real Git repository,
 * read it with the read-only Git readers, select the visible graph for a
 * fixed "now", lay it out, and write a technical SVG.
 *
 *   npm run render:fixture -- <fixture> <now ISO 8601> <out.svg>
 *   npm run render:fixture -- gardenTour 2026-09-22T15:00:00-04:00 docs/decisions/assets/garden-tour.svg
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyWindow } from "../src/core/business-days.ts";
import {
  lanePriority,
  refLabels,
  snapshotGraphInput,
} from "../src/core/snapshot-graph.ts";
import { buildVisibleGraph } from "../src/core/visible-graph.ts";
import { readCommitDetails } from "../src/git/commits.ts";
import { readSnapshot } from "../src/git/snapshot.ts";
import { layoutGraph } from "../src/render/layout.ts";
import { renderSvg } from "../src/render/svg.ts";
import { buildFixture } from "../src/demo/builder.ts";
import { demoFixtures, type DemoFixtureName } from "../src/demo/fixtures.ts";

const [name, nowIso, out] = process.argv.slice(2);
if (
  !name ||
  !(name in demoFixtures) ||
  !nowIso ||
  !out ||
  Number.isNaN(Date.parse(nowIso))
) {
  console.error(
    `Usage: render-fixture <${Object.keys(demoFixtures).join("|")}> <now ISO 8601> <out.svg>`,
  );
  process.exit(2);
}

const spec = demoFixtures[name as DemoFixtureName];
const dir = await mkdtemp(join(tmpdir(), "git-flower-garden-render-"));
try {
  const fixture = await buildFixture(spec, join(dir, "repo"));
  const snapshot = await readSnapshot(fixture.dir);
  const window = historyWindow(
    {
      businessDays: 2,
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      timeZone: "America/New_York",
    },
    Date.parse(nowIso),
  );
  const graph = buildVisibleGraph(snapshotGraphInput(snapshot, window));
  const layout = layoutGraph(graph, { priority: lanePriority(snapshot) });
  const details = await readCommitDetails(fixture.dir, [...graph.nodes.keys()]);
  const svg = renderSvg(graph, layout, {
    title: `${spec.description} Viewed ${nowIso}.`,
    refs: refLabels(snapshot),
    subjects: new Map([...details].map(([oid, d]) => [oid, d.subject])),
  });
  await writeFile(out, `${svg}\n`);
  console.log(
    `${out}: ${String(graph.nodes.size)} visible of ${String(graph.reachableCount)} reachable commits, ${String(graph.edges.length)} edges, ${String(graph.tails.length)} tails`,
  );
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
