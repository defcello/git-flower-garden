/**
 * Owns the latest coherent snapshot and status of every configured source
 * (roadmap sections 5 and 5.2). One read runs per repository at a time;
 * concurrent requests share it. A failed refresh keeps the last good
 * snapshot and marks the source stale, so one broken repository never blanks
 * the garden or blocks the others.
 */
import { stat } from "node:fs/promises";
import type { Config, RepositoryConfig } from "../config/config.ts";
import { historyWindow } from "../core/business-days.ts";
import {
  lanePriority,
  refLabels,
  snapshotGraphInput,
} from "../core/snapshot-graph.ts";
import { buildVisibleGraph, type VisibleGraph } from "../core/visible-graph.ts";
import { readCommitDetails, type CommitDetails } from "../git/commits.ts";
import { redactCredentials } from "../git/run-git.ts";
import { readSnapshot, type RepositorySnapshot } from "../git/snapshot.ts";
import { layoutGraph, type Layout } from "../render/layout.ts";

export type SourceState =
  "initializing" | "ready" | "stale" | "offline" | "error" | "incomplete";

export interface SourceStatus {
  state: SourceState;
  /** Milliseconds since the epoch. */
  lastAttempt: number | null;
  lastSuccess: number | null;
  /** Sanitized, human-readable explanation for non-ready states. */
  diagnostic: string | null;
}

export interface RepositoryView {
  id: string;
  label: string;
  kind: "local" | "remote";
  /** Increases on every successful refresh. */
  revision: number;
  status: SourceStatus;
  snapshot: RepositorySnapshot | null;
}

export interface GraphView {
  id: string;
  revision: number;
  graph: VisibleGraph;
  layout: Layout;
  labels: Map<string, string[]>;
  details: Map<string, CommitDetails>;
}

interface Entry {
  config: RepositoryConfig;
  view: RepositoryView;
  inFlight: Promise<RepositoryView> | null;
  details: Map<string, CommitDetails>;
}

export interface ServiceOptions {
  now?: () => number;
  readSnapshot?: typeof readSnapshot;
}

export class RepositoryService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly read: typeof readSnapshot;
  config: Config;

  constructor(config: Config, options: ServiceOptions = {}) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.read = options.readSnapshot ?? readSnapshot;
    for (const repo of config.repositories) this.add(repo);
  }

  private add(repo: RepositoryConfig): void {
    this.entries.set(repo.id, {
      config: repo,
      inFlight: null,
      details: new Map(),
      view: {
        id: repo.id,
        label: repo.label,
        kind: repo.path === undefined ? "remote" : "local",
        revision: 0,
        snapshot: null,
        status: {
          state: "initializing",
          lastAttempt: null,
          lastSuccess: null,
          diagnostic: null,
        },
      },
    });
  }

  ids(): string[] {
    return this.config.repositories.map((r) => r.id);
  }

  view(id: string): RepositoryView | undefined {
    return this.entries.get(id)?.view;
  }

  /** Re-read one repository. Concurrent callers share the same read. */
  refresh(id: string): Promise<RepositoryView> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown repository ${id}`));
    entry.inFlight ??= this.doRefresh(entry).finally(() => {
      entry.inFlight = null;
    });
    return entry.inFlight;
  }

  refreshAll(): Promise<RepositoryView[]> {
    return Promise.all(this.ids().map((id) => this.refresh(id)));
  }

  private async doRefresh(entry: Entry): Promise<RepositoryView> {
    const attempt = this.now();
    const previous = entry.view;
    if (entry.config.path === undefined) {
      entry.view = {
        ...previous,
        status: {
          state: "error",
          lastAttempt: attempt,
          lastSuccess: previous.status.lastSuccess,
          diagnostic:
            "Remote-only sources are not monitored yet (roadmap P1-D).",
        },
      };
      return entry.view;
    }
    try {
      // A missing working directory makes spawn report "git ENOENT", which
      // reads like Git is not installed; check the path first.
      const info = await stat(entry.config.path).catch(() => null);
      if (!info?.isDirectory())
        throw new Error(`Path not found: ${entry.config.path}`);
      const snapshot = await this.read(entry.config.path, { now: this.now });
      const problems = describeIncomplete(snapshot);
      entry.view = {
        ...previous,
        revision: previous.revision + 1,
        snapshot,
        status: {
          state: problems ? "incomplete" : "ready",
          lastAttempt: attempt,
          lastSuccess: this.now(),
          diagnostic: problems,
        },
      };
    } catch (error) {
      const message = redactCredentials(
        error instanceof Error ? error.message : String(error),
      );
      entry.view = {
        ...previous,
        status: {
          state: previous.snapshot ? "stale" : "error",
          lastAttempt: attempt,
          lastSuccess: previous.status.lastSuccess,
          diagnostic: friendly(message),
        },
      };
    }
    return entry.view;
  }

  /** Visible graph, layout, labels, and subjects for the current snapshot and clock. */
  async graph(
    id: string,
    reveal: readonly string[] = [],
  ): Promise<GraphView | undefined> {
    const entry = this.entries.get(id);
    const snapshot = entry?.view.snapshot;
    if (!entry || !snapshot) return undefined;
    const window = historyWindow(this.config.history, this.now());
    const graph = buildVisibleGraph(
      snapshotGraphInput(snapshot, window, reveal),
    );
    const layout = layoutGraph(graph, { priority: lanePriority(snapshot) });
    const missing = [...graph.nodes.keys()].filter(
      (oid) => !entry.details.has(oid),
    );
    if (missing.length > 0) {
      const cwd = snapshot.location.workTree ?? snapshot.location.gitDir;
      // Commit objects are immutable, so details are cached by OID for good.
      for (const [oid, d] of await readCommitDetails(cwd, missing))
        entry.details.set(oid, d);
    }
    const details = new Map(
      [...graph.nodes.keys()].flatMap((oid) => {
        const d = entry.details.get(oid);
        return d ? [[oid, d] as const] : [];
      }),
    );
    return {
      id,
      revision: entry.view.revision,
      graph,
      layout,
      labels: refLabels(snapshot),
      details,
    };
  }
}

function describeIncomplete(snapshot: RepositorySnapshot): string | null {
  const c = snapshot.completeness;
  const notes: string[] = [];
  if (!c.coherent)
    notes.push("refs kept changing while reading; showing the latest read");
  if (c.shallow) notes.push("shallow clone: older history is missing");
  if (c.grafts)
    notes.push("legacy info/grafts present: parentage may be altered");
  if (c.missingTips.length > 0)
    notes.push(`${String(c.missingTips.length)} ref target(s) unavailable`);
  return notes.length > 0 ? notes.join("; ") : null;
}

function friendly(message: string): string {
  if (/not a git repository/i.test(message))
    return `Not a Git repository: ${message}`;
  if (/^Path not found/.test(message)) return message;
  if (/spawn git ENOENT/.test(message))
    return "Git was not found on PATH. Install Git 2.36 or newer.";
  if (/dubious ownership/i.test(message)) {
    return `Git refused the repository because another user owns it (safe.directory). ${message}`;
  }
  return message;
}
