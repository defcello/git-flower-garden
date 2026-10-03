/**
 * The Model's data at one moment (ADR 0022), without the DOM: shared by the
 * store (garden-model.ts), the view models, and tests.
 */
import type {
  GraphJson,
  RepositoriesJson,
  RepositoryStatusJson,
} from "../../api/types.ts";

export interface GardenSnapshot {
  repositories: RepositoriesJson | null;
  graphs: ReadonlyMap<string, GraphJson>;
  /** When repository status was last received (milliseconds since the epoch). */
  fetchedAt: number;
  /** Set while the live connection is down; the last data stays on screen. */
  connectionError: string | null;
}

export const EMPTY_SNAPSHOT: GardenSnapshot = {
  repositories: null,
  graphs: new Map(),
  fetchedAt: 0,
  connectionError: null,
};

/** Whether the service has a graph for this repository. */
export function needsGraph(repo: RepositoryStatusJson): boolean {
  return repo.revision > 0 && repo.counts !== null;
}
