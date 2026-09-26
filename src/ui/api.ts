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
  /** Set when the service cannot be reached; the last data stays on screen. */
  connectionError: string | null;
}

const POLL_MS = 3000;
/** Re-fetch graphs at least this often: the recent window moves with the clock. */
const GRAPH_MAX_AGE_MS = 60_000;

function needsGraph(repo: RepositoryStatusJson): boolean {
  return repo.revision > 0 && repo.counts !== null;
}

/**
 * Poll the service for repository status and fetch each graph when its
 * snapshot revision changes. (Server-sent events replace polling in P1-D.)
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
  const fetched = useRef(new Map<string, { revision: number; at: number }>());

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const repos = await getJson<RepositoriesJson>(
          "/api/repositories",
          controller.signal,
        );
        setRepositories(repos);
        setFetchedAt(Date.now());
        setConnectionError(null);
        const ids = new Set(repos.repositories.map((r) => r.id));
        const updates = await Promise.all(
          repos.repositories.filter(needsGraph).flatMap((repo) => {
            const last = fetched.current.get(repo.id);
            const fresh =
              last &&
              last.revision === repo.revision &&
              Date.now() - last.at < GRAPH_MAX_AGE_MS;
            if (fresh) return [];
            return [
              getJson<GraphJson>(
                `/api/repositories/${encodeURIComponent(repo.id)}/graph`,
                controller.signal,
              ).then((graph) => {
                fetched.current.set(repo.id, {
                  revision: repo.revision,
                  at: Date.now(),
                });
                return graph;
              }),
            ];
          }),
        );
        setGraphs((previous) => {
          const next = new Map([...previous].filter(([id]) => ids.has(id)));
          for (const graph of updates) next.set(graph.id, graph);
          return next;
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnectionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return { repositories, graphs, connectionError, fetchedAt };
}
