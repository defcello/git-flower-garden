/**
 * Continuous monitoring of every configured source (roadmap sections 5 and 5.2).
 *
 * Per repository:
 * - One read at a time. Triggers that arrive during a read are merged into a
 *   single follow-up read, so a change made mid-read is never missed and a
 *   burst of events never queues a burst of reads.
 * - Filesystem watchers are hints (debounced 250 ms); a reconcile timer is the
 *   source of truth. A failed read keeps the last good snapshot ("stale").
 * - Remotes are fetched into an app-owned cache on a jittered timer, with a
 *   global concurrency limit and exponential backoff; local monitoring keeps
 *   running whatever the network does. Remote freshness is reported
 *   separately from local freshness.
 * - The revision changes only when what the graph shows changed, so quiet
 *   reconciles do not make clients refetch.
 *
 * Changes are published to listeners (the server-sent event hub).
 */
import { access, mkdir, stat } from "node:fs/promises";
import { cpus } from "node:os";
import {
  githubFromUrl,
  type Config,
  type RepositoryConfig,
} from "../config/config.ts";
import { defaultCacheDir } from "../config/paths.ts";
import { historyWindow, nextRecomputeMs } from "../core/business-days.ts";
import {
  lanePriority,
  refLabels,
  snapshotGraphInput,
} from "../core/snapshot-graph.ts";
import { buildVisibleGraph, type VisibleGraph } from "../core/visible-graph.ts";
import { readCommitDetails, type CommitDetails } from "../git/commits.ts";
import { ensureCache, fetchIntoCache, remoteUrl } from "../git/remote-cache.ts";
import {
  readLocalWithRemotes,
  readRemoteOnlySnapshot,
  type CachedRemote,
} from "../git/remote-snapshot.ts";
import { redactCredentials } from "../git/run-git.ts";
import { readSnapshot, type RepositorySnapshot } from "../git/snapshot.ts";
import type { GitWorktree } from "../git/worktrees.ts";
import { layoutGraph, type Layout } from "../render/layout.ts";
import { cachedRemotes, objectsDir, readMeta, writeMeta } from "./cache.ts";
import { refFingerprint } from "./probe.ts";
import { watchRepository, type RepositoryWatch } from "./watch.ts";

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

export interface RemoteStatus {
  /** "pending" before the first fetch attempt finishes. */
  state: "pending" | "ok" | "error";
  lastAttempt: number | null;
  /** Last successful fetch, including one remembered from a previous run. */
  lastSuccess: number | null;
  nextAttempt: number | null;
  diagnostic: string | null;
  /** Last accepted push notification for this repository (P1-F), if any. */
  lastEvent: number | null;
}

export interface RepositoryView {
  id: string;
  label: string;
  kind: "local" | "remote";
  /** Changes whenever what the graph shows may have changed. */
  revision: number;
  status: SourceStatus;
  /** Freshness of monitored remotes; null for local-only sources. */
  remote: RemoteStatus | null;
  snapshot: RepositorySnapshot | null;
}

export interface GraphView {
  id: string;
  revision: number;
  graph: VisibleGraph;
  layout: Layout;
  labels: Map<string, string[]>;
  details: Map<string, CommitDetails>;
  completeness: RepositorySnapshot["completeness"];
  /** Commits revealed for inspection that exist in this repository. */
  revealed: string[];
  worktrees: GitWorktree[];
}

export interface TagSummary {
  name: string;
  shortName: string;
  /** Commit the tag resolves to, or null for tags of trees/blobs/missing objects. */
  commitOid: string | null;
  objectType: string;
  peeledType: string | null;
}

export interface Timings {
  /** Duration of the most recent read of the repository (and its cache). */
  lastReadMs: number | null;
  /** Duration of the most recent graph selection, layout, and detail read. */
  lastGraphMs: number | null;
  /** Duration of the most recent fetch of all monitored remotes. */
  lastFetchMs: number | null;
  reads: number;
  fetches: number;
  fetchFailures: number;
}

export interface RepositoryDiagnostics {
  id: string;
  kind: "local" | "remote";
  revision: number;
  status: SourceStatus;
  remote: RemoteStatus | null;
  counts: {
    refs: number;
    worktrees: number;
    reachableCommits: number;
    visibleCommits: number | null;
  } | null;
  timings: Timings;
  consecutiveFetchFailures: number;
  watching: boolean;
  cacheDirectory: string | null;
}

export type ServiceEvent =
  | { type: "repository"; id: string }
  | { type: "repositories" }
  | { type: "window" };

export interface ServiceOptions {
  now?: () => number;
  /** Replaces local snapshot reads (tests). */
  readSnapshot?: typeof readSnapshot;
  /** Root of app-owned caches; defaults to the per-user cache directory. */
  cacheRoot?: string;
  /** Run watchers and timers. Off by default so unit tests stay deterministic. */
  background?: boolean;
  /** Filesystem watchers (with background); reconciliation still runs without them. */
  watch?: boolean;
  /** Overrides for tests; production uses the configuration. */
  intervals?: {
    reconcileMs?: number;
    /** Safety poll while push notifications are active (default: webhooks.safetyPollSeconds). */
    safetyPollMs?: number;
    /** Full read at least this often, even when the fingerprint is unchanged. */
    fullReconcileMs?: number;
    remotePollMs?: number;
    debounceMs?: number;
  };
  /** Random source for jitter (tests). */
  random?: () => number;
  /** Maximum concurrent repository reads (default: half the logical CPUs, at least 2). */
  readConcurrency?: number;
}

interface Entry {
  config: RepositoryConfig;
  view: RepositoryView;
  remotes: CachedRemote[];
  /** Remotes with fetched (or remembered) cache contents. */
  fetched: Set<string>;
  /** A read loop is running. */
  running: boolean;
  /** Another read is wanted after the current one. */
  pending: boolean;
  readsStarted: number;
  /** Tail of the queue of cache reads and fetches (see withCache). */
  cacheLock: Promise<void>;
  waiters: { target: number; resolve: (view: RepositoryView) => void }[];
  fingerprint: string | null;
  details: Map<string, CommitDetails>;
  lastGraph: { key: string; view: GraphView } | null;
  watch: RepositoryWatch | null;
  watchedDir: string | null;
  debounce: ReturnType<typeof setTimeout> | null;
  remoteTimer: ReturnType<typeof setTimeout> | null;
  remoteFailures: number;
  timings: Timings;
  /** Stat fingerprint of ref metadata taken just before the last successful read. */
  probe: string | null;
  probeDir: string | null;
  /** performance.now() of the last successful full read. */
  lastFullRead: number;
  fetchAbort: AbortController | null;
  stopped: boolean;
  /** GitHub "owner/name" (lowercase) this repository's remotes correspond to. */
  githubNames: Set<string>;
  fetching: boolean;
  fetchAgain: boolean;
}

const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** Bounds the number of concurrent fetches across all repositories. */
class Semaphore {
  private active = 0;
  private limit: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  setLimit(limit: number): void {
    this.limit = limit;
    this.drain();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.drain();
    });
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active++;
      (this.waiting.shift() as () => void)();
    }
  }
}

export class RepositoryService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly read: typeof readSnapshot;
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private readonly cacheRoot: string;
  private readonly background: boolean;
  private readonly watchFiles: boolean;
  private readonly random: () => number;
  private readonly fetches: Semaphore;
  /** Bounds concurrent local reads so a large garden does not thrash a small machine. */
  private readonly readSlots: Semaphore;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private webhooksActive = false;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private windowStart: number | null = null;
  private readonly intervals: NonNullable<ServiceOptions["intervals"]>;
  config: Config;

  constructor(config: Config, options: ServiceOptions = {}) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.read = options.readSnapshot ?? readSnapshot;
    this.cacheRoot = options.cacheRoot ?? defaultCacheDir();
    this.background = options.background ?? false;
    this.watchFiles = options.watch ?? true;
    this.random = options.random ?? Math.random;
    this.intervals = options.intervals ?? {};
    this.fetches = new Semaphore(config.monitor.maxConcurrentFetches);
    this.readSlots = new Semaphore(
      options.readConcurrency ?? Math.max(2, Math.floor(cpus().length / 2)),
    );
    for (const repo of config.repositories) this.add(repo);
  }

  // ---- events -------------------------------------------------------------

  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ServiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ---- lifecycle ----------------------------------------------------------

  private add(repo: RepositoryConfig): Entry {
    const remotes = cachedRemotes(repo);
    const entry: Entry = {
      config: repo,
      remotes,
      fetched: new Set(),
      running: false,
      pending: false,
      readsStarted: 0,
      cacheLock: Promise.resolve(),
      waiters: [],
      fingerprint: null,
      details: new Map(),
      lastGraph: null,
      watch: null,
      watchedDir: null,
      debounce: null,
      remoteTimer: null,
      remoteFailures: 0,
      timings: {
        lastReadMs: null,
        lastGraphMs: null,
        lastFetchMs: null,
        reads: 0,
        fetches: 0,
        fetchFailures: 0,
      },
      probe: null,
      probeDir: null,
      lastFullRead: 0,
      fetchAbort: null,
      githubNames: new Set(repo.github ? [repo.github.toLowerCase()] : []),
      fetching: false,
      fetchAgain: false,
      stopped: false,
      view: {
        id: repo.id,
        label: repo.label,
        kind: repo.path === undefined ? "remote" : "local",
        revision: 0,
        snapshot: null,
        remote:
          remotes.length > 0
            ? {
                state: "pending",
                lastAttempt: null,
                lastSuccess: null,
                nextAttempt: null,
                diagnostic: null,
                lastEvent: null,
              }
            : null,
        status: {
          state: "initializing",
          lastAttempt: null,
          lastSuccess: null,
          diagnostic: null,
        },
      },
    };
    this.entries.set(repo.id, entry);
    return entry;
  }

  /**
   * Serialize everything that touches one repository's cache: a read never
   * sees a fetch half-applied, and two fetches never write at once.
   */
  private async withCache<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const previous = entry.cacheLock;
    let release = (): void => undefined;
    entry.cacheLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /** Read through a call: stop() can run while a fetch or read is awaited. */
  private isStopped(entry: Entry): boolean {
    return entry.stopped;
  }

  private stopEntry(entry: Entry): void {
    entry.stopped = true;
    entry.watch?.close();
    entry.watch = null;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.remoteTimer) clearTimeout(entry.remoteTimer);
    entry.fetchAbort?.abort();
  }

  /**
   * Initial read of every source (remembered remote state first), then, with
   * `background`, start watchers and timers.
   */
  async start(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((e) => this.restoreRemotes(e)),
    );
    await this.refreshAll();
    if (!this.background) return;
    this.startTimers();
    let stagger = 0;
    for (const entry of this.entries.values()) {
      // Stagger first fetches so a large garden does not hit the network at once.
      if (entry.remotes.length > 0) this.scheduleFetch(entry, stagger);
      stagger += 250;
    }
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.reconcileTimer = null;
    this.windowTimer = null;
    for (const entry of this.entries.values()) this.stopEntry(entry);
  }

  private startTimers(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const reconcileMs =
      this.intervals.reconcileMs ??
      this.config.monitor.localReconcileSeconds * 1000;
    this.reconcileTimer = setInterval(() => {
      // Local sources only; remote-only sources change only when fetched.
      for (const entry of this.entries.values()) {
        if (entry.config.path !== undefined) void this.reconcile(entry);
      }
      this.checkWindow();
    }, reconcileMs);
    this.reconcileTimer.unref();
    this.scheduleWindowTimer();
  }

  /** Recompute at the next local midnight, and on every tick in case the clock jumped. */
  private scheduleWindowTimer(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    const now = this.now();
    const delay = Math.max(
      1000,
      nextRecomputeMs(now, this.config.history.timeZone) - now + 1000,
    );
    this.windowTimer = setTimeout(
      () => {
        this.checkWindow();
        this.scheduleWindowTimer();
      },
      Math.min(delay, 2 ** 31 - 1),
    );
    this.windowTimer.unref();
  }

  /** Publish a "window" event when the recent-history window has moved. */
  checkWindow(): void {
    const start = historyWindow(this.config.history, this.now()).startMs;
    if (this.windowStart !== null && start !== this.windowStart) {
      this.windowStart = start;
      this.emit({ type: "window" });
      return;
    }
    this.windowStart = start;
  }

  windowStartMs(): number {
    return historyWindow(this.config.history, this.now()).startMs;
  }

  /** Apply a new valid configuration without restarting unaffected sources. */
  async applyConfig(next: Config): Promise<void> {
    const before = this.config;
    this.config = next;
    this.fetches.setLimit(next.monitor.maxConcurrentFetches);
    const nextById = new Map(next.repositories.map((r) => [r.id, r]));
    const started: string[] = [];
    const replacedRevisions = new Map<string, number>();
    for (const [id, entry] of this.entries) {
      const repo = nextById.get(id);
      const sameSource =
        repo !== undefined &&
        repo.path === entry.config.path &&
        repo.url === entry.config.url &&
        repo.remotes.join("\n") === entry.config.remotes.join("\n") &&
        repo.github === entry.config.github;
      if (!sameSource) {
        if (repo !== undefined) replacedRevisions.set(id, entry.view.revision);
        this.stopEntry(entry);
        this.entries.delete(id);
      } else {
        entry.config = repo;
        entry.view = { ...entry.view, label: repo.label };
        entry.lastGraph = null; // history or display settings may have changed
      }
    }
    // Rebuild in configuration order.
    const ordered = new Map<string, Entry>();
    for (const repo of next.repositories) {
      let entry = this.entries.get(repo.id);
      if (!entry) {
        entry = this.add(repo);
        entry.view = {
          ...entry.view,
          revision: replacedRevisions.get(repo.id) ?? entry.view.revision,
        };
        started.push(repo.id);
      }
      ordered.set(repo.id, entry);
    }
    this.entries.clear();
    for (const [id, entry] of ordered) this.entries.set(id, entry);

    const timingChanged =
      before.monitor.localReconcileSeconds !==
        next.monitor.localReconcileSeconds ||
      before.history.timeZone !== next.history.timeZone;
    if (this.background && timingChanged) this.startTimers();
    this.windowStart = null;
    this.checkWindow();
    this.emit({ type: "repositories" });
    await Promise.all(
      started.map(async (id) => {
        const entry = this.entries.get(id) as Entry;
        await this.restoreRemotes(entry);
        await this.refresh(id);
        if (this.background && entry.remotes.length > 0)
          this.scheduleFetch(entry, 0);
      }),
    );
  }

  ids(): string[] {
    return this.config.repositories
      .map((r) => r.id)
      .filter((id) => this.entries.has(id));
  }

  view(id: string): RepositoryView | undefined {
    return this.entries.get(id)?.view;
  }

  // ---- local reads --------------------------------------------------------

  /**
   * Re-read one repository. Requests made while a read runs are merged into
   * one more read after it. Each caller's promise resolves when a read that
   * *started after its request* completes, so a stream of new requests (e.g.
   * reconcile ticks on a slow repository) can never keep a caller waiting.
   */
  refresh(id: string): Promise<RepositoryView> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown repository ${id}`));
    entry.pending = true;
    const target = entry.readsStarted + 1;
    const done = new Promise<RepositoryView>((resolve) => {
      entry.waiters.push({ target, resolve });
    });
    if (!entry.running) void this.runReads(entry);
    return done;
  }

  private async runReads(entry: Entry): Promise<void> {
    entry.running = true;
    try {
      while (entry.pending && !this.isStopped(entry)) {
        entry.pending = false;
        entry.readsStarted++;
        const started = entry.readsStarted;
        const t0 = performance.now();
        await this.readSlots.run(() => this.doRefresh(entry));
        entry.timings.lastReadMs = Math.round(performance.now() - t0);
        entry.timings.reads++;
        this.settle(entry, started);
      }
    } finally {
      entry.running = false;
      // A stopped entry resolves everyone with its last view.
      this.settle(entry, Number.POSITIVE_INFINITY);
    }
  }

  private settle(entry: Entry, completed: number): void {
    const remaining: Entry["waiters"] = [];
    for (const waiter of entry.waiters) {
      if (waiter.target <= completed) waiter.resolve(entry.view);
      else remaining.push(waiter);
    }
    entry.waiters = remaining;
  }

  refreshAll(): Promise<RepositoryView[]> {
    return Promise.all(this.ids().map((id) => this.refresh(id)));
  }

  private setView(entry: Entry, view: RepositoryView): void {
    const before = entry.view;
    entry.view = view;
    const changed =
      before.revision !== view.revision ||
      before.status.state !== view.status.state ||
      before.status.diagnostic !== view.status.diagnostic ||
      JSON.stringify(before.remote) !== JSON.stringify(view.remote);
    if (changed && !entry.stopped)
      this.emit({ type: "repository", id: entry.config.id });
  }

  private async doRefresh(entry: Entry): Promise<void> {
    const attempt = this.now();
    const repo = entry.config;
    try {
      let snapshot: RepositorySnapshot | null;
      if (repo.path !== undefined) {
        // A missing working directory makes spawn report "git ENOENT", which
        // reads like Git is not installed; check the path first.
        const info = await stat(repo.path).catch(() => null);
        if (!info?.isDirectory())
          throw new Error(`Path not found: ${repo.path}`);
        snapshot =
          entry.remotes.length > 0 && entry.fetched.size > 0
            ? await this.withCache(entry, () =>
                readLocalWithRemotes(
                  repo.path as string,
                  objectsDir(this.cacheRoot, repo.id),
                  entry.remotes,
                  {
                    now: this.now,
                    fetched: entry.fetched,
                    fingerprint: refFingerprint,
                  },
                ),
              )
            : await this.read(repo.path, {
                now: this.now,
                fingerprint: refFingerprint,
              });
      } else {
        const remote = entry.remotes[0] as CachedRemote;
        snapshot = entry.fetched.has(remote.key)
          ? await this.withCache(entry, () =>
              readRemoteOnlySnapshot(
                objectsDir(this.cacheRoot, repo.id),
                remote,
                {
                  now: this.now,
                },
              ),
            )
          : null;
      }
      if (entry.stopped) return;
      // Read the view at write time: a fetch may have updated it meanwhile.
      const previous = entry.view;
      if (snapshot === null) {
        // Remote-only source that has never been fetched.
        this.setView(entry, {
          ...previous,
          status: {
            state:
              previous.remote?.state === "error" ? "offline" : "initializing",
            lastAttempt: attempt,
            lastSuccess: null,
            diagnostic:
              previous.remote?.state === "error"
                ? previous.remote.diagnostic
                : "Waiting for the first fetch from the remote.",
          },
        });
        return;
      }
      if (repo.path !== undefined) {
        this.ensureWatch(entry, snapshot);
        // Taken before the read, so a change made during it shows up next tick.
        entry.probe = snapshot.fingerprint ?? null;
        entry.probeDir = snapshot.location.commonDir;
        entry.lastFullRead = performance.now();
      }
      const fingerprint = snapshotFingerprint(snapshot);
      const changed = fingerprint !== entry.fingerprint;
      entry.fingerprint = fingerprint;
      const problems = describeIncomplete(snapshot);
      const remoteNote = remoteStaleNote(
        entry.view.remote,
        repo.path === undefined,
      );
      this.setView(entry, {
        ...previous,
        revision: changed ? previous.revision + 1 : previous.revision,
        snapshot: changed ? snapshot : (previous.snapshot ?? snapshot),
        status: {
          state: problems ? "incomplete" : remoteNote ? "stale" : "ready",
          lastAttempt: attempt,
          lastSuccess: this.now(),
          diagnostic: [problems, remoteNote].filter(Boolean).join("; ") || null,
        },
      });
    } catch (error) {
      if (this.isStopped(entry)) return;
      const previous = entry.view;
      const message = redactCredentials(
        error instanceof Error ? error.message : String(error),
      );
      this.setView(entry, {
        ...previous,
        status: {
          state: previous.snapshot ? "stale" : "error",
          lastAttempt: attempt,
          lastSuccess: previous.status.lastSuccess,
          diagnostic: friendly(message),
        },
      });
    }
  }

  private ensureWatch(entry: Entry, snapshot: RepositorySnapshot): void {
    if (!this.background || !this.watchFiles || entry.stopped) return;
    const dir = snapshot.location.commonDir;
    if (entry.watch && entry.watchedDir === dir) return;
    entry.watch?.close();
    entry.watchedDir = dir;
    entry.watch = watchRepository(
      { commonDir: dir, gitDirs: [snapshot.location.gitDir] },
      () => {
        this.hint(entry);
      },
      () => {
        // Watching failed (e.g. network filesystem): reconciliation carries on.
        entry.watch?.close();
        entry.watch = null;
        entry.watchedDir = null;
      },
    );
  }

  /**
   * One reconciliation tick: a full read if the stat fingerprint of the ref
   * metadata changed, or if the last full read is older than the full
   * reconciliation interval (the backstop for coarse timestamps and changes
   * outside the Git directory). Otherwise no Git process is started.
   */
  private async reconcile(entry: Entry): Promise<void> {
    // A read already in progress: skip this tick. The next tick compares
    // fingerprints against that read, so a change made meanwhile is still
    // caught; queuing another read here would, on a slow machine where reads
    // outlast the tick, keep a repository reading forever.
    if (entry.stopped || entry.running) return;
    const fullMs = this.intervals.fullReconcileMs ?? 5 * 60_000;
    if (
      entry.probe === null ||
      entry.probeDir === null ||
      performance.now() - entry.lastFullRead > fullMs
    ) {
      void this.refresh(entry.config.id);
      return;
    }
    await this.checkFingerprint(entry);
  }

  /** Read if the ref metadata fingerprint differs from the last read's (or none is known). */
  private async checkFingerprint(entry: Entry): Promise<void> {
    if (entry.stopped) return;
    if (entry.probe === null || entry.probeDir === null) {
      void this.refresh(entry.config.id);
      return;
    }
    const current = await refFingerprint(entry.probeDir);
    if (current !== entry.probe) void this.refresh(entry.config.id);
  }

  private hint(entry: Entry): void {
    if (entry.stopped) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      // Watch events include metadata noise, notably last-access-time updates
      // caused by Git's own reads on Windows, which would otherwise make every
      // read trigger another. Only a changed fingerprint (sizes, modification
      // times, directory listings) leads to a read.
      void this.checkFingerprint(entry);
    }, this.intervals.debounceMs ?? 250);
    entry.debounce.unref();
  }

  // ---- remotes ------------------------------------------------------------

  /** Use cache contents from a previous run as last-known state. */
  private async restoreRemotes(entry: Entry): Promise<void> {
    if (entry.remotes.length === 0) return;
    const dir = objectsDir(this.cacheRoot, entry.config.id);
    const exists = await access(dir).then(
      () => true,
      () => false,
    );
    if (!exists) return;
    const meta = await readMeta(this.cacheRoot, entry.config.id);
    let lastSuccess: number | null = null;
    for (const remote of entry.remotes) {
      const known = meta.remotes[remote.key]?.lastSuccess ?? null;
      if (known !== null) {
        entry.fetched.add(remote.key);
        lastSuccess = Math.max(lastSuccess ?? 0, known);
      }
    }
    if (lastSuccess !== null && entry.view.remote) {
      entry.view = {
        ...entry.view,
        remote: {
          ...entry.view.remote,
          lastSuccess,
          diagnostic: "Checking the remote for changes…",
        },
      };
    }
  }

  private scheduleFetch(entry: Entry, delayMs: number): void {
    if (entry.stopped) return;
    if (entry.remoteTimer) clearTimeout(entry.remoteTimer);
    const nextAttempt = this.now() + delayMs;
    if (entry.view.remote) {
      entry.view = {
        ...entry.view,
        remote: { ...entry.view.remote, nextAttempt },
      };
    }
    entry.remoteTimer = setTimeout(() => {
      entry.remoteTimer = null;
      entry.fetching = true;
      void this.fetchRemotes(entry.config.id).finally(() => {
        entry.fetching = false;
        // A notification during the fetch may describe a newer push: fetch again now.
        const again = entry.fetchAgain;
        entry.fetchAgain = false;
        this.scheduleFetch(entry, again ? 0 : this.nextFetchDelay(entry));
      });
    }, delayMs);
    entry.remoteTimer.unref();
  }

  /** Poll interval ±10% jitter; after failures, exponential backoff to 15 minutes. */
  private nextFetchDelay(entry: Entry): number {
    // With push notifications active, polling is only a safety net.
    const notified = this.webhooksActive && entry.githubNames.size > 0;
    const base = notified
      ? (this.intervals.safetyPollMs ??
        this.config.webhooks.safetyPollSeconds * 1000)
      : (this.intervals.remotePollMs ??
        this.config.monitor.remotePollSeconds * 1000);
    const delay =
      entry.remoteFailures === 0
        ? base
        : Math.min(
            MAX_BACKOFF_MS,
            base * 2 ** Math.min(entry.remoteFailures, 16),
          );
    return Math.round(delay * (0.9 + this.random() * 0.2));
  }

  /**
   * Mark push notifications as active (the receiver is listening) or not.
   * Inactive means ordinary polling for every remote.
   */
  setWebhooksActive(active: boolean): void {
    this.webhooksActive = active;
  }

  /**
   * A push notification for GitHub repository "owner/name": fetch every
   * monitored repository that maps to it now (or right after a fetch in
   * progress). Returns the matching repository IDs.
   */
  notifyGithub(fullName: string): string[] {
    const name = fullName.toLowerCase();
    const matched: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.remotes.length === 0 || !entry.githubNames.has(name)) continue;
      matched.push(entry.config.id);
      if (entry.view.remote) {
        this.setView(entry, {
          ...entry.view,
          remote: { ...entry.view.remote, lastEvent: this.now() },
        });
      }
      if (entry.fetching) entry.fetchAgain = true;
      else this.scheduleFetch(entry, 0);
    }
    return matched;
  }

  /** Fetch every monitored remote of one repository now (also used for manual retry). */
  async fetchRemotes(id: string): Promise<RepositoryView | undefined> {
    const entry = this.entries.get(id);
    if (!entry || entry.remotes.length === 0 || entry.stopped)
      return entry?.view;
    const fetchStarted = performance.now();
    const attempt = this.now();
    const dir = objectsDir(this.cacheRoot, entry.config.id);
    const errors: string[] = [];
    const meta = await readMeta(this.cacheRoot, entry.config.id);
    for (const remote of entry.remotes) {
      const abort = new AbortController();
      entry.fetchAbort = abort;
      try {
        const url =
          entry.config.url ??
          (await remoteUrl(entry.config.path as string, remote.name));
        const github = githubFromUrl(url);
        if (github) entry.githubNames.add(github.toLowerCase());
        await mkdir(dir, { recursive: true });
        await ensureCache(dir);
        await this.withCache(entry, () =>
          this.fetches.run(() =>
            fetchIntoCache(dir, remote.key, url, {
              timeoutMs: this.config.monitor.fetchTimeoutSeconds * 1000,
              signal: abort.signal,
            }),
          ),
        );
        if (this.isStopped(entry)) return entry.view;
        meta.remotes[remote.key] = {
          url: redactCredentials(url),
          lastSuccess: this.now(),
        };
        entry.fetched.add(remote.key);
      } catch (error) {
        if (this.isStopped(entry)) return entry.view;
        const message = redactCredentials(
          error instanceof Error ? error.message : String(error),
        );
        errors.push(`${remote.name}: ${fetchDiagnostic(message)}`);
      } finally {
        entry.fetchAbort = null;
      }
    }
    await writeMeta(this.cacheRoot, entry.config.id, meta).catch(
      () => undefined,
    );
    entry.remoteFailures = errors.length > 0 ? entry.remoteFailures + 1 : 0;
    entry.timings.fetches++;
    if (errors.length > 0) entry.timings.fetchFailures++;
    entry.timings.lastFetchMs = Math.round(performance.now() - fetchStarted);
    const previous = entry.view.remote as RemoteStatus;
    this.setView(entry, {
      ...entry.view,
      remote: {
        state: errors.length > 0 ? "error" : "ok",
        lastAttempt: attempt,
        lastSuccess: errors.length > 0 ? previous.lastSuccess : this.now(),
        nextAttempt: previous.nextAttempt,
        diagnostic: errors.length > 0 ? errors.join("; ") : null,
        lastEvent: previous.lastEvent,
      },
    });
    await this.refresh(id);
    return entry.view;
  }

  // ---- graph --------------------------------------------------------------

  /** Visible graph, layout, labels, and subjects for the current snapshot and clock. */
  async graph(
    id: string,
    reveal: readonly string[] = [],
  ): Promise<GraphView | undefined> {
    const entry = this.entries.get(id);
    const snapshot = entry?.view.snapshot;
    if (!entry || !snapshot) return undefined;
    const now = this.now();
    const window = historyWindow(this.config.history, now);
    const revealed = [...new Set(reveal)]
      .filter((oid) => snapshot.topology.commits.has(oid))
      .sort();
    // Selection depends on the snapshot, the window, the reveal set, and
    // (for future-dated commits) the current minute. Reuse the last result
    // when none of those changed: large histories take seconds to select.
    const key = [
      entry.view.revision,
      window.startMs,
      Math.floor(now / 60_000),
      revealed.join(","),
    ].join("|");
    if (entry.lastGraph?.key === key) return entry.lastGraph.view;

    const t0 = performance.now();
    const graph = buildVisibleGraph(
      snapshotGraphInput(snapshot, window, revealed),
    );
    const layout = layoutGraph(graph, { priority: lanePriority(snapshot) });
    const missing = [...graph.nodes.keys()].filter(
      (oid) => !entry.details.has(oid),
    );
    if (missing.length > 0) {
      // Commit objects are immutable, so details are cached by OID.
      const read = await readCommitDetails(snapshot.objects.cwd, missing, {
        alternates: snapshot.objects.alternates,
      });
      for (const [oid, d] of read) entry.details.set(oid, d);
    }
    const details = new Map(
      [...graph.nodes.keys()].flatMap((oid) => {
        const d = entry.details.get(oid);
        return d ? [[oid, d] as const] : [];
      }),
    );
    // Keep only what is visible so an all-day monitor's cache stays bounded.
    entry.details = new Map(details);
    const view: GraphView = {
      id,
      revision: entry.view.revision,
      graph,
      layout,
      labels: refLabels(snapshot),
      details,
      completeness: snapshot.completeness,
      revealed,
      worktrees: snapshot.worktrees,
    };
    entry.lastGraph = { key, view };
    entry.timings.lastGraphMs = Math.round(performance.now() - t0);
    return view;
  }

  /** Operational details for troubleshooting (roadmap P1-E). */
  diagnostics(): RepositoryDiagnostics[] {
    return this.ids().map((id) => {
      const entry = this.entries.get(id) as Entry;
      const snapshot = entry.view.snapshot;
      return {
        id,
        kind: entry.view.kind,
        revision: entry.view.revision,
        status: entry.view.status,
        remote: entry.view.remote,
        counts: snapshot
          ? {
              refs: snapshot.refs.length,
              worktrees: snapshot.worktrees.length,
              reachableCommits: snapshot.topology.commits.size,
              visibleCommits: entry.lastGraph?.view.graph.nodes.size ?? null,
            }
          : null,
        timings: { ...entry.timings },
        consecutiveFetchFailures: entry.remoteFailures,
        watching: entry.watch !== null,
        cacheDirectory:
          entry.remotes.length > 0 ? objectsDir(this.cacheRoot, id) : null,
      };
    });
  }

  cacheDirectory(): string {
    return this.cacheRoot;
  }

  /**
   * Search every tag, including old ones whose commits are hidden (roadmap
   * section 4.4). Matching is a case-insensitive substring of the short name.
   */
  tags(id: string, query = "", limit = 200): TagSummary[] | undefined {
    const snapshot = this.entries.get(id)?.view.snapshot;
    if (!snapshot) return undefined;
    const q = query.toLowerCase();
    return snapshot.refs
      .filter((r) => r.kind === "tag" && r.shortName.toLowerCase().includes(q))
      .sort((a, b) => (a.shortName < b.shortName ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({
        name: r.name,
        shortName: r.shortName,
        commitOid: r.commitOid,
        objectType: r.objectType,
        peeledType: r.peeledType,
      }));
  }
}

/** What the graph depends on: ref and worktree targets, topology size, completeness. */
function snapshotFingerprint(snapshot: RepositorySnapshot): string {
  return JSON.stringify([
    snapshot.refs.map((r) => [r.name, r.oid, r.commitOid]),
    snapshot.worktrees.map((w) => [
      w.path,
      w.headOid,
      w.branch,
      w.locked,
      w.prunable,
    ]),
    snapshot.topology.commits.size,
    snapshot.completeness,
  ]);
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

/** Remote-only sources are stale when their remote cannot be reached. */
function remoteStaleNote(
  remote: RemoteStatus | null,
  remoteOnly: boolean,
): string | null {
  if (!remoteOnly || !remote || remote.state !== "error") return null;
  return `remote unreachable; showing the state fetched ${remote.lastSuccess ? "earlier" : "previously"}`;
}

function fetchDiagnostic(message: string): string {
  if (
    /terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey\)|401|403/i.test(
      message,
    )
  ) {
    return `authentication needed. Check that \`git ls-remote\` works for this remote in a terminal, using your credential helper or SSH agent. (${message})`;
  }
  if (
    /Could not resolve host|unable to access|Connection (refused|timed out)|does not appear to be a git repository|not found/i.test(
      message,
    )
  ) {
    return `remote unreachable (${message})`;
  }
  return message;
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
