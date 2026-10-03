/**
 * JSON contract between the local service and the browser UI. Plain data
 * only: no Node or DOM types, so both sides import it.
 */
import type {
  WeatherConditions,
  WeatherState,
} from "../environment/weather.ts";

export type { WeatherConditions, WeatherState };

export type SourceState =
  "initializing" | "ready" | "stale" | "offline" | "error" | "incomplete";

export interface SourceStatusJson {
  state: SourceState;
  lastAttempt: number | null;
  lastSuccess: number | null;
  diagnostic: string | null;
}

export interface RemoteStatusJson {
  state: "pending" | "ok" | "error";
  lastAttempt: number | null;
  lastSuccess: number | null;
  nextAttempt: number | null;
  diagnostic: string | null;
  lastEvent: number | null;
}

export interface RepositoryStatusJson {
  id: string;
  label: string;
  kind: "local" | "remote";
  revision: number;
  status: SourceStatusJson;
  /** Freshness of monitored remotes, reported separately from local state. */
  remote: RemoteStatusJson | null;
  counts: { refs: number; worktrees: number; reachableCommits: number } | null;
}

export interface DisplayJson {
  timeZone: string;
  businessDays: number;
  reducedMotion: boolean;
  /**
   * The renderer to open on until the viewer picks one (`display.renderer`).
   * Absent from services older than this field.
   */
  renderer?: string;
  /** Start of the recent-history window; when it moves, graphs change. */
  windowStartMs: number;
  /** A notice to show on every page, e.g. demo mode. */
  notice: string | null;
  /** Where the real-time sky is computed (in the browser); null when off. */
  environment: EnvironmentJson | null;
}

export interface EnvironmentJson {
  latitude: number;
  longitude: number;
  elevationMeters: number;
  timeZone: string;
  /** Weather from the provider (ADR 0020); null or absent when off. */
  weather?: WeatherJson | null;
}

export interface WeatherJson {
  state: WeatherState;
  /** The forecast for the current hour; null when waiting or unavailable. */
  conditions: WeatherConditions | null;
  /** When the forecast was last fetched or confirmed (ms); null before. */
  fetchedAt: number | null;
  /** Why the last request failed, or a provider notice. */
  diagnostic: string | null;
}

export interface RepositoriesJson {
  apiVersion: number;
  display: DisplayJson;
  repositories: RepositoryStatusJson[];
  /** Problems in the configuration file; the last valid configuration stays active. */
  configErrors: string[];
  /** Settings that need a restart to take effect. */
  restartNeeded: string[];
  /** Optional GitHub push notifications (P1-F). */
  webhooks: WebhooksJson;
}

export interface WebhooksJson {
  state: "off" | "listening" | "error";
  /** Where the receiver listens (loopback; exposed by the user's tunnel or proxy). */
  url: string | null;
  diagnostic: string | null;
  lastEvent: number | null;
}

export type InclusionReasonJson =
  "head" | "ancestor" | "recent" | "worktree" | "inspection";

export interface SignatureJson {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  timezone: string;
}

export interface WorktreeJson {
  path: string;
  branch: string | null;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
  main: boolean;
}

export interface GraphNodeJson {
  oid: string;
  lane: number;
  row: number;
  x: number;
  y: number;
  reasons: InclusionReasonJson[];
  anchorFor: readonly string[];
  futureDated: boolean;
  boundary: boolean;
  /** Display labels: branch names, `remote/branch`, `tag: name`. */
  refs: string[];
  subject: string;
  message: string;
  parents: string[];
  author: SignatureJson | null;
  committer: SignatureJson | null;
  worktrees: WorktreeJson[];
}

export interface PointJson {
  x: number;
  y: number;
}

export interface GraphEdgeJson {
  child: string;
  parent: string;
  kind: "direct" | "collapsed";
  hidden: number | null;
  from: PointJson;
  to: PointJson;
  detour?: number;
}

export interface GraphTailJson {
  child: string;
  hidden: number | null;
  boundary: boolean;
  from: PointJson;
  to: PointJson;
}

export interface GraphJson {
  id: string;
  revision: number;
  window: {
    startMs: number;
    endMs: number;
    businessDates: string[];
    timeZone: string;
  };
  reachableCount: number;
  completeness: {
    coherent: boolean;
    attempts: number;
    shallow: boolean;
    grafts: boolean;
    missingTips: string[];
  };
  revealed: string[];
  nodes: GraphNodeJson[];
  edges: GraphEdgeJson[];
  tails: GraphTailJson[];
  size: { width: number; height: number; lanes: number; rows: number };
}

export interface TagJson {
  name: string;
  shortName: string;
  commitOid: string | null;
  objectType: string;
  peeledType: string | null;
}
