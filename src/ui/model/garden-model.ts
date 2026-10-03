/**
 * The Model, as the browser sees it (ADR 0022): the repositories, their
 * graphs, and the environment the local service reports, kept current in one
 * framework-free store. Renderers never fetch; they read this store through
 * view models (../viewmodel/). A renderer written in another language reads
 * the same data from the HTTP API instead (docs/api.md).
 *
 * Two sources fill it: the live service over server-sent events, and the
 * static GitHub Pages demo's saved snapshot.
 */
import type {
  GraphJson,
  RepositoriesJson,
  RepositoryStatusJson,
} from "../../api/types.ts";
import { EMPTY_SNAPSHOT, needsGraph, type GardenSnapshot } from "./snapshot.ts";

export { EMPTY_SNAPSHOT, needsGraph, type GardenSnapshot };

/**
 * A store in the shape React's `useSyncExternalStore` expects: snapshots are
 * immutable and replaced on every change. The source starts with the first
 * subscriber and stops with the last.
 */
export interface GardenModel {
  getSnapshot: () => GardenSnapshot;
  subscribe: (listener: () => void) => () => void;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal: signal ?? null,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)}`);
  return (await response.json()) as T;
}

/**
 * A store around a source that runs while anyone is subscribed. `start`
 * receives a setter and returns its own stop function.
 */
function sourceModel(
  start: (
    update: (change: (previous: GardenSnapshot) => GardenSnapshot) => void,
  ) => () => void,
): GardenModel {
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const update = (change: (previous: GardenSnapshot) => GardenSnapshot) => {
    const next = change(snapshot);
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      stop ??= start(update);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}

/**
 * Live data over server-sent events (roadmap section 5.2). Each event carries
 * every repository's status; a graph is fetched when its revision or the
 * history window changes. Responses that arrive after a newer one are
 * discarded, so an old graph can never overwrite a newer one. The browser's
 * EventSource reconnects on its own, and the first message after a reconnect
 * resynchronizes everything.
 */
export function liveGardenModel(base = "/api/"): GardenModel {
  return sourceModel((update) => {
    const controller = new AbortController();
    const events = new EventSource(`${base}events`);
    /** Per repository: the graph version requested most recently. */
    const requested = new Map<string, string>();
    /** Per repository: the newest revision already shown. */
    const shown = new Map<string, number>();

    const loadGraph = async (
      repo: RepositoryStatusJson,
      key: string,
    ): Promise<void> => {
      try {
        const graph = await getJson<GraphJson>(
          `${base}repositories/${encodeURIComponent(repo.id)}/graph`,
          controller.signal,
        );
        // Ignore a response overtaken by a newer request or an already-shown newer revision.
        if (requested.get(repo.id) !== key) return;
        if (graph.revision < (shown.get(repo.id) ?? 0)) return;
        shown.set(repo.id, graph.revision);
        update((previous) => ({
          ...previous,
          graphs: new Map(previous.graphs).set(graph.id, graph),
        }));
      } catch (error) {
        if (!controller.signal.aborted) {
          // The next status message will request it again.
          requested.delete(repo.id);
          update((previous) => ({
            ...previous,
            connectionError:
              error instanceof Error ? error.message : String(error),
          }));
        }
      }
    };

    events.addEventListener("repositories", (message: MessageEvent<string>) => {
      const repos = JSON.parse(message.data) as RepositoriesJson;
      const ids = new Set(repos.repositories.map((r) => r.id));
      const graphIds = new Set(
        repos.repositories.filter(needsGraph).map((repo) => repo.id),
      );
      for (const id of [...requested.keys()]) {
        if (!ids.has(id)) {
          requested.delete(id);
          shown.delete(id);
        }
      }
      update((previous) => ({
        repositories: repos,
        fetchedAt: Date.now(),
        connectionError: null,
        graphs: [...previous.graphs.keys()].every((id) => graphIds.has(id))
          ? previous.graphs
          : new Map([...previous.graphs].filter(([id]) => graphIds.has(id))),
      }));
      for (const repo of repos.repositories.filter(needsGraph)) {
        const key = `${String(repo.revision)}|${String(repos.display.windowStartMs)}`;
        if (requested.get(repo.id) === key) continue;
        requested.set(repo.id, key);
        void loadGraph(repo, key);
      }
    });
    events.onerror = () => {
      update((previous) => ({
        ...previous,
        connectionError: "connection lost; reconnecting",
      }));
    };
    events.onopen = () => {
      // A reconnect may be to a restarted service whose revisions start over:
      // forget what was shown and let the first message request everything.
      requested.clear();
      shown.clear();
      update((previous) =>
        previous.connectionError === null
          ? previous
          : { ...previous, connectionError: null },
      );
    };

    return () => {
      controller.abort();
      events.close();
    };
  });
}

/**
 * The static GitHub Pages demo (`vite build --mode pages`): a snapshot of the
 * API responses, saved by scripts/pages-snapshot.ts and loaded once. There is
 * no service to watch the repositories, so nothing updates.
 */
export function snapshotGardenModel(base: string): GardenModel {
  let loaded: GardenSnapshot | null = null;
  return sourceModel((update) => {
    if (loaded) {
      const done = loaded;
      update(() => done);
      return () => undefined;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [snapshot, repositories] = await Promise.all([
          getJson<{ takenAt: number }>(
            `${base}snapshot.json`,
            controller.signal,
          ),
          getJson<RepositoriesJson>(
            `${base}repositories.json`,
            controller.signal,
          ),
        ]);
        const graphs = await Promise.all(
          repositories.repositories
            .filter(needsGraph)
            .map((repo) =>
              getJson<GraphJson>(
                `${base}graphs/${encodeURIComponent(repo.id)}.json`,
                controller.signal,
              ),
            ),
        );
        loaded = {
          repositories,
          graphs: new Map(graphs.map((graph) => [graph.id, graph])),
          // Ages and the recent window read as of the snapshot.
          fetchedAt: snapshot.takenAt,
          connectionError: null,
        };
        const done = loaded;
        update(() => done);
      } catch (error) {
        if (!controller.signal.aborted)
          update((previous) => ({
            ...previous,
            connectionError:
              error instanceof Error ? error.message : String(error),
          }));
      }
    })();
    return () => {
      controller.abort();
    };
  });
}
