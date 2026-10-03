/**
 * The garden's view model (ADR 0022): what every renderer needs to know
 * about the repositories, derived once from the Model's snapshot. Pure and
 * framework-free, so a renderer of any kind (DOM, canvas, WebGL, a video
 * pipeline fed from the browser) reads the same health rules and never
 * re-derives them from the wire format.
 */
import type {
  GraphJson,
  RemoteStatusJson,
  RepositoryStatusJson,
  SourceState,
} from "../../api/types.ts";
import { STATE_TEXT } from "../format.ts";
import type { GardenSnapshot } from "../model/snapshot.ts";

export interface RepositoryHealth {
  state: SourceState;
  /** The state's glyph and word (never color alone). */
  glyph: string;
  word: string;
  /** The repository has no commits at all. */
  empty: boolean;
  /** A last-known (stale or incomplete) state: draw it faded, like a wilting plant. */
  wilting: boolean;
  /** A monitored remote cannot be reached. */
  remoteDown: boolean;
  /**
   * The glyph a quiet in-world marker carries, or null when nothing is
   * wrong (roadmap section 7: health without text).
   */
  marker: string | null;
}

export interface RepositoryView {
  id: string;
  label: string;
  /** The service's status record, for details beyond the health summary. */
  status: RepositoryStatusJson;
  remote: RemoteStatusJson | null;
  /** The visible graph; undefined while it loads or when it cannot be read. */
  graph: GraphJson | undefined;
  health: RepositoryHealth;
  /** A readable graph with commits: there is a plant to draw. */
  drawable: boolean;
  /** Position in configuration order, stable while the list is unchanged. */
  index: number;
}

export interface GardenView {
  /** "loading" until the first status arrives; "empty" with nothing configured. */
  phase: "loading" | "empty" | "ready";
  repositories: RepositoryView[];
  timeZone: string;
  businessDays: number;
  /** When the status was received; ages are measured from here. */
  now: number;
  reducedMotion: boolean;
  connectionError: string | null;
}

export function repositoryHealth(repo: RepositoryStatusJson): RepositoryHealth {
  const state = repo.status.state;
  const remoteDown = repo.remote?.state === "error";
  const { glyph, word } = STATE_TEXT[state];
  return {
    state,
    glyph,
    word,
    empty: repo.counts?.reachableCommits === 0,
    wilting: state === "stale" || state === "incomplete",
    remoteDown,
    marker: state !== "ready" ? glyph : remoteDown ? "⊘" : null,
  };
}

/** Whether a repository draws a plant: a readable graph with commits. */
export function drawsPlant(
  repo: RepositoryStatusJson,
  graph: GraphJson | undefined,
): graph is GraphJson {
  return graph !== undefined && repo.counts?.reachableCommits !== 0;
}

export function gardenView(snapshot: GardenSnapshot): GardenView {
  const { repositories, graphs } = snapshot;
  const repos = repositories?.repositories ?? [];
  return {
    phase: !repositories ? "loading" : repos.length === 0 ? "empty" : "ready",
    repositories: repos.map((repo, index) => {
      const graph = graphs.get(repo.id);
      return {
        id: repo.id,
        label: repo.label,
        status: repo,
        remote: repo.remote,
        graph,
        health: repositoryHealth(repo),
        drawable: drawsPlant(repo, graph),
        index,
      };
    }),
    timeZone: repositories?.display.timeZone ?? "UTC",
    businessDays: repositories?.display.businessDays ?? 0,
    now: snapshot.fetchedAt,
    reducedMotion: repositories?.display.reducedMotion === true,
    connectionError: snapshot.connectionError,
  };
}
