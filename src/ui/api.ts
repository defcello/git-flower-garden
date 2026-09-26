import { useEffect, useRef, useState } from "react";
import type {
  GraphJson,
  RepositoriesJson,
  RepositoryStatusJson,
} from "../api/types.ts";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal: signal ?? null,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)}`);
  return (await response.json()) as T;
}

export interface GardenData {
  repositories: RepositoriesJson | null;
  graphs: ReadonlyMap<string, GraphJson>;
  /** When repository status was last received (milliseconds since the epoch). */
  fetchedAt: number;
  /** Set while the live connection is down; the last data stays on screen. */
  connectionError: string | null;
}

function needsGraph(repo: RepositoryStatusJson): boolean {
  return repo.revision > 0 && repo.counts !== null;
}

/**
 * Live data over server-sent events (roadmap section 5.2). Each event carries
 * every repository's status; a graph is fetched when its revision or the
 * history window changes. Responses that arrive after a newer one are
 * discarded, so an old graph can never overwrite a newer one. The browser's
 * EventSource reconnects on its own, and the first message after a reconnect
 * resynchronizes everything.
 */
export function useGardenData(): GardenData {
  const [repositories, setRepositories] = useState<RepositoriesJson | null>(
    null,
  );
  const [graphs, setGraphs] = useState<ReadonlyMap<string, GraphJson>>(
    new Map(),
  );
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  /** Per repository: the graph version requested most recently. */
  const requested = useRef(new Map<string, string>());
  /** Per repository: the newest revision already shown. */
  const shown = useRef(new Map<string, number>());

  useEffect(() => {
    const controller = new AbortController();
    const events = new EventSource("/api/events");

    const loadGraph = async (
      repo: RepositoryStatusJson,
      key: string,
    ): Promise<void> => {
      try {
        const graph = await getJson<GraphJson>(
          `/api/repositories/${encodeURIComponent(repo.id)}/graph`,
          controller.signal,
        );
        // Ignore a response overtaken by a newer request or an already-shown newer revision.
        if (requested.current.get(repo.id) !== key) return;
        if (graph.revision < (shown.current.get(repo.id) ?? 0)) return;
        shown.current.set(repo.id, graph.revision);
        setGraphs((previous) => new Map(previous).set(graph.id, graph));
      } catch (error) {
        if (!controller.signal.aborted) {
          // The next status message will request it again.
          requested.current.delete(repo.id);
          setConnectionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    };

    events.addEventListener("repositories", (message: MessageEvent<string>) => {
      const repos = JSON.parse(message.data) as RepositoriesJson;
      setRepositories(repos);
      setFetchedAt(Date.now());
      setConnectionError(null);
      const ids = new Set(repos.repositories.map((r) => r.id));
      for (const id of [...requested.current.keys()]) {
        if (!ids.has(id)) {
          requested.current.delete(id);
          shown.current.delete(id);
        }
      }
      setGraphs((previous) =>
        [...previous.keys()].every((id) => ids.has(id))
          ? previous
          : new Map([...previous].filter(([id]) => ids.has(id))),
      );
      for (const repo of repos.repositories.filter(needsGraph)) {
        const key = `${String(repo.revision)}|${String(repos.display.windowStartMs)}`;
        if (requested.current.get(repo.id) === key) continue;
        requested.current.set(repo.id, key);
        void loadGraph(repo, key);
      }
    });
    events.onerror = () => {
      setConnectionError("connection lost; reconnecting");
    };
    events.onopen = () => {
      // A reconnect may be to a restarted service whose revisions start over:
      // forget what was shown and let the first message request everything.
      requested.current.clear();
      shown.current.clear();
      setConnectionError(null);
    };

    return () => {
      controller.abort();
      events.close();
    };
  }, []);

  return { repositories, graphs, connectionError, fetchedAt };
}
