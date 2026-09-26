/*
 * Time and memory of the ancestor-anchor selector on synthetic histories.
 *
 *   npm run bench:ancestors               # ordinary workload and stress cases
 *   npm run bench:ancestors -- --quick    # small smoke run
 *
 * Each case runs in a fresh Node process so memory baselines and peak RSS are
 * not polluted by earlier cases. Histories model a main line plus side
 * branches that fork, advance, and sometimes merge back (occasionally into
 * another side branch). Object IDs are 40-character hex strings so map memory
 * resembles a real SHA-1 repository.
 *
 * Results are recorded in docs/decisions/0007-ancestor-selector-evidence.md.
 */
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { selectAncestorAnchors } from "../src/core/ancestor-anchors.ts";
import { seededRandom } from "../tests/oracle/random-dag.ts";

interface Case {
  label: string;
  commits: number;
  heads: number;
}

const CASES: Case[] = [
  { label: "ordinary (roadmap target)", commits: 100_000, heads: 100 },
  { label: "many heads", commits: 100_000, heads: 1_000 },
  { label: "long history", commits: 1_000_000, heads: 100 },
  { label: "stress (roadmap)", commits: 1_000_000, heads: 1_000 },
];
const QUICK: Case[] = [{ label: "smoke", commits: 10_000, heads: 20 }];

const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0);

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function history(seed: number, commits: number, heads: number) {
  const random = seededRandom(seed);
  const pick = (n: number): number => Math.floor(random() * n);
  const parents = new Map<string, string[]>();
  const lanes: string[] = [oid(0)]; // lanes[0] is main
  parents.set(oid(0), []);
  const targetLanes = heads * 2;

  for (let i = 1; i < commits; i++) {
    const id = oid(i);
    if (lanes.length < targetLanes && random() < 0.02) {
      // New side branch forking from the current main tip.
      parents.set(id, [lanes[0] as string]);
      lanes.push(id);
      continue;
    }
    const lane =
      random() < 0.4 || lanes.length === 1 ? 0 : 1 + pick(lanes.length - 1);
    const own = [lanes[lane] as string];
    let merged = -1;
    if (lanes.length > 1 && random() < 0.03) {
      const other = 1 + pick(lanes.length - 1);
      if (other !== lane) {
        own.push(lanes[other] as string);
        merged = other;
      }
    }
    parents.set(id, own);
    lanes[lane] = id;
    // Most merged side branches are then deleted.
    if (merged !== -1 && random() < 0.7) lanes.splice(merged, 1);
  }

  // Heads: main plus a random sample of side-branch tips (or old commits if short).
  const chosen = new Set<string>([lanes[0] as string]);
  const tips = lanes.slice(1);
  while (chosen.size < heads) {
    chosen.add(
      tips.length > 0
        ? (tips.splice(pick(tips.length), 1)[0] as string)
        : oid(pick(commits)),
    );
  }
  return { parents, heads: [...chosen] };
}

/** Run one case in this process and print one Markdown table row. */
function runCase(c: Case): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("Run with node --expose-gc");
  const used = (): number => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers; // typed arrays live in arrayBuffers
  };

  gc();
  const baseline = used();
  const { parents, heads } = history(42, c.commits, c.heads);
  gc();
  const graphBytes = used() - baseline;

  const runs = c.commits >= 1_000_000 ? 3 : 5;
  const times: number[] = [];
  let anchors = 0;
  for (let r = 0; r < runs; r++) {
    gc();
    const t0 = performance.now();
    anchors = selectAncestorAnchors(parents, heads).length;
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] as number;
  const bitsetBytes = c.commits * Math.ceil(c.heads / 32) * 4;
  const peakRss = process.resourceUsage().maxRSS * 1024;

  console.log(
    [
      c.label,
      c.commits.toLocaleString("en-US"),
      c.heads.toLocaleString("en-US"),
      mib(graphBytes),
      `${median.toFixed(0)} (${String(runs)})`,
      mib(bitsetBytes),
      mib(peakRss),
      anchors.toLocaleString("en-US"),
    ]
      .join(" | ")
      .replace(/^/, "| ") + " |",
  );
}

const caseIndex = process.argv.indexOf("--case");
if (caseIndex !== -1) {
  const all = [...CASES, ...QUICK];
  runCase(all[Number(process.argv[caseIndex + 1])] as Case);
} else {
  const quick = process.argv.includes("--quick");
  const indices = quick ? [CASES.length] : CASES.map((_, i) => i);
  console.log(
    `Node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} x${String(cpus().length)}, ${mib(totalmem())} MiB RAM, ${process.platform}`,
  );
  console.log(
    "| Case | Commits | Heads | Graph input MiB | Selector median ms (runs) | Bitsets MiB | Peak process RSS MiB | Anchors |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const i of indices) {
    const row = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=4096",
        fileURLToPath(import.meta.url),
        "--case",
        String(i),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    process.stdout.write(row);
  }
}
