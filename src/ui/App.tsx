import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import type {
  GraphJson,
  GraphNodeJson,
  RemoteStatusJson,
  RepositoryStatusJson,
} from "../api/types.ts";
import { useGardenData } from "./api.ts";
import { Details } from "./Details.tsx";
import { BotanicalGraph } from "./BotanicalGraph.tsx";
import type { Renderer, Lighting } from "./botanical.ts";
import { FocusGraph } from "./FocusGraph.tsx";
import {
  describeNode,
  durationText,
  reasonText,
  relativeTime,
  shortOid,
  STATE_TEXT,
} from "./format.ts";
import { GraphSvg, graphWidth } from "./GraphSvg.tsx";
import {
  HILLSIDE_SLOTS,
  hillsideSlots,
  type HillsideSlot,
} from "./hillside.ts";

interface Selection {
  repoId: string;
  oid: string;
}

interface Hover {
  node: GraphNodeJson;
  x: number;
  y: number;
}

/** Offset of the plot's graph drawing inside its card, used to center the focus button over the tree. */
const PLOT_PADDING = 16;
export const FOCUS_BUTTON = 44;

export function App() {
  const { repositories, graphs, connectionError, fetchedAt } = useGardenData();
  // The technical view stays the default until the garden is accepted; a
  // viewer's own choice is remembered in this browser only.
  const [renderer, setRenderer] = useState<Renderer>(loadRenderer);
  const [lighting, setLighting] = useState<Lighting>("day");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const gardenReturn = useRef<{ scrollY: number; plotId: string } | null>(null);

  const repos = repositories?.repositories ?? [];
  const timeZone = repositories?.display.timeZone ?? "UTC";
  const focused = repos.find((r) => r.id === focusedId);
  // The hillside has 64 fixed plant slots; dense planting is intended (focus
  // view isolates one plant). Larger gardens use the card layout.
  const sceneMode =
    renderer !== "technical" && repos.length <= HILLSIDE_SLOTS.length;
  const sceneSlots = sceneMode ? hillsideSlots(repos.length) : [];
  // A focused repository that disappears from the configuration shows the garden.
  const activeFocusId = focused ? focusedId : null;

  useEffect(() => {
    document.documentElement.classList.toggle(
      "reduce-motion",
      repositories?.display.reducedMotion === true,
    );
  }, [repositories?.display.reducedMotion]);

  const enterFocus = useCallback((id: string) => {
    gardenReturn.current = { scrollY: window.scrollY, plotId: id };
    setHover(null);
    setFocusedId(id);
  }, []);

  const exitFocus = useCallback(() => {
    setHover(null);
    setFocusedId(null);
  }, []);

  // Restore the garden camera (scroll position) and keyboard focus on return.
  useLayoutEffect(() => {
    if (activeFocusId !== null || !gardenReturn.current) return;
    const { scrollY, plotId } = gardenReturn.current;
    gardenReturn.current = null;
    window.scrollTo(0, scrollY);
    document
      .querySelector<HTMLElement>(`[data-plot="${CSS.escape(plotId)}"]`)
      ?.focus({ preventScroll: true });
  }, [activeFocusId]);

  // Escape closes details first, then leaves focus view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selection) setSelection(null);
      else if (activeFocusId !== null) exitFocus();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [selection, activeFocusId, exitFocus]);

  const onHover = useCallback(
    (node: GraphNodeJson | null, event?: React.PointerEvent) => {
      setHover(
        node && event ? { node, x: event.clientX, y: event.clientY } : null,
      );
    },
    [],
  );

  const selectedGraph = selection ? graphs.get(selection.repoId) : undefined;
  const selectedRepo = selection
    ? repos.find((r) => r.id === selection.repoId)
    : undefined;

  return (
    <div
      className={`app${renderer !== "technical" ? ` botanical lighting-${lighting}` : ""}`}
    >
      {renderer !== "technical" && (
        <div className="landscape" aria-hidden="true">
          <div className="landscape-background" />
          <div className="landscape-hill" />
          <div className="landscape-vignette" />
        </div>
      )}
      <header className="topbar">
        <h1>git-flower-garden</h1>
        {repositories && (
          <span className="summary">
            {repos.length} {repos.length === 1 ? "repository" : "repositories"}{" "}
            · last {repositories.display.businessDays} business days ·{" "}
            {timeZone}
          </span>
        )}
        <label className="preview-control">
          View
          <select
            aria-label="Renderer"
            value={renderer}
            onChange={(event) => {
              const next = event.target.value as Renderer;
              setRenderer(next);
              saveRenderer(next);
            }}
          >
            <option value="technical">Technical</option>
            <option value="canvas">Garden preview · Canvas</option>
            <option value="svg">Garden preview · SVG</option>
          </select>
        </label>
        {renderer !== "technical" && (
          <label className="preview-control">
            Lighting study
            <select
              aria-label="Lighting study"
              value={lighting}
              onChange={(event) => {
                setLighting(event.target.value as Lighting);
              }}
            >
              <option value="day">Day</option>
              <option value="dawn">Dawn</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          </label>
        )}
        <Legend />
      </header>
      {renderer !== "technical" && (
        <div className="art-notice" role="note">
          Art preview · {lighting} lighting study, not live conditions. Flowers
          = branch heads · leaves = commits · fruit = tags · gold markers =
          worktrees. Dashed stems hide history; red boundaries mean missing
          history.
        </div>
      )}
      {repositories?.display.notice && (
        <div className="banner notice" role="note">
          {repositories.display.notice}
        </div>
      )}
      {repositories && repositories.configErrors.length > 0 && (
        <div className="banner" role="alert">
          <strong>
            The configuration file has problems; the last valid configuration is
            still in use.
          </strong>
          <ul>
            {repositories.configErrors.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {repositories?.webhooks.state === "error" && (
        <div className="banner" role="status">
          {repositories.webhooks.diagnostic}
        </div>
      )}
      {repositories && repositories.restartNeeded.length > 0 && (
        <div className="banner" role="status">
          Restart git-flower-garden to apply changes to{" "}
          {repositories.restartNeeded.join(", ")}.
        </div>
      )}
      {connectionError && (
        <div className="banner" role="status">
          Live updates interrupted ({connectionError}). Showing the last known
          state.
        </div>
      )}
      {!repositories ? (
        <p className="loading" role="status">
          Loading…
        </p>
      ) : repos.length === 0 ? (
        <div className="welcome">
          <h2>No repositories are configured yet</h2>
          <p>
            Add entries to <code>repositories</code> in your configuration file,
            check it with <code>git-flower-garden validate-config</code>, then
            restart the service.
          </p>
        </div>
      ) : focused ? (
        <FocusView
          renderer={renderer}
          repo={focused}
          graph={graphs.get(focused.id)}
          timeZone={timeZone}
          now={fetchedAt}
          selection={selection}
          onSelect={(oid) => {
            setSelection({ repoId: focused.id, oid });
          }}
          onCloseDetails={() => {
            setSelection(null);
          }}
          onHover={onHover}
          onExit={exitFocus}
        />
      ) : (
        <main
          className={`garden${sceneMode ? " garden-scene" : ""}`}
          aria-label="All repositories"
        >
          {repos.map((repo, index) => (
            <Plot
              renderer={renderer}
              key={repo.id}
              repo={repo}
              graph={graphs.get(repo.id)}
              now={fetchedAt}
              selectedOid={selection?.repoId === repo.id ? selection.oid : null}
              onFocus={() => {
                enterFocus(repo.id);
              }}
              onSelect={(oid) => {
                setSelection({ repoId: repo.id, oid });
              }}
              onHover={onHover}
              slot={
                sceneMode
                  ? (HILLSIDE_SLOTS[sceneSlots[index] ?? 0] ?? null)
                  : null
              }
            />
          ))}
        </main>
      )}
      {selection && !focused && (
        <div className="drawer">
          <Details
            graph={selectedGraph}
            repoLabel={selectedRepo?.label ?? selection.repoId}
            oid={selection.oid}
            timeZone={timeZone}
            onClose={() => {
              setSelection(null);
            }}
            onSelect={(oid) => {
              setSelection({ repoId: selection.repoId, oid });
            }}
          />
        </div>
      )}
      {hover && <Tooltip hover={hover} />}
    </div>
  );
}

function Tooltip({ hover }: { hover: Hover }) {
  const { node } = hover;
  // Keep the tooltip inside the viewport.
  const left = Math.min(hover.x + 14, window.innerWidth - 340);
  const top = Math.min(hover.y + 14, window.innerHeight - 120);
  return (
    <div className="tooltip" role="tooltip" style={{ left, top }}>
      {node.refs.length > 0 && (
        <div className="refs">{node.refs.join(", ")}</div>
      )}
      <div>
        <code>{shortOid(node.oid)}</code> {node.subject}
      </div>
      <div className="muted">
        {reasonText(node.reasons)} · click for details
      </div>
    </div>
  );
}

function StatusLine({
  repo,
  graph,
  now,
}: {
  repo: RepositoryStatusJson;
  graph: GraphJson | undefined;
  /** When the status was fetched; ages are measured from here. */
  now: number;
}) {
  const { glyph, word } = STATE_TEXT[repo.status.state];
  return (
    <div className={`status state-${repo.status.state}`}>
      <span aria-hidden="true" className="glyph">
        {glyph}
      </span>{" "}
      <span className="word">{word}</span>
      {repo.status.lastSuccess !== null && repo.status.state !== "ready" && (
        <span className="muted">
          {" "}
          · last read {relativeTime(repo.status.lastSuccess, now)}
        </span>
      )}
      {graph && (
        <span className="muted">
          {" "}
          ·{" "}
          {graph.reachableCount === 0
            ? "no commits yet"
            : `${String(graph.nodes.length)} of ${String(graph.reachableCount)} commits shown`}
        </span>
      )}
      {repo.status.diagnostic && (
        <div className="diagnostic">{repo.status.diagnostic}</div>
      )}
      {repo.remote && <RemoteLine remote={repo.remote} now={now} />}
    </div>
  );
}

/** Remote freshness, reported separately from the local repository's state. */
function RemoteLine({
  remote,
  now,
}: {
  remote: RemoteStatusJson;
  now: number;
}) {
  const checked =
    remote.lastSuccess === null
      ? "never fetched"
      : `fetched ${relativeTime(remote.lastSuccess, now)}`;
  const next =
    remote.nextAttempt !== null && remote.nextAttempt > now
      ? ` · next check in ${durationText(remote.nextAttempt - now)}`
      : "";
  return (
    <div className={`remote remote-${remote.state}`}>
      <span aria-hidden="true" className="glyph">
        {remote.state === "error" ? "✕" : remote.state === "ok" ? "⇅" : "…"}
      </span>{" "}
      Remote:{" "}
      {remote.state === "error"
        ? "unreachable"
        : remote.state === "pending"
          ? "checking"
          : "up to date"}{" "}
      · {checked}
      {remote.lastEvent !== null &&
        ` · notified ${relativeTime(remote.lastEvent, now)}`}
      {next}
      {remote.state === "error" && remote.diagnostic && (
        <div className="diagnostic">{remote.diagnostic}</div>
      )}
    </div>
  );
}

function PlotBody({
  repo,
  graph,
  children,
}: {
  repo: RepositoryStatusJson;
  graph: GraphJson | undefined;
  children: React.ReactNode;
}) {
  if (repo.counts?.reachableCommits === 0) {
    return (
      <p className="placeholder">No commits yet: this repository is empty.</p>
    );
  }
  if (!graph) {
    return (
      <p className="placeholder">
        {repo.status.state === "initializing"
          ? "Reading repository…"
          : "No graph: the repository could not be read."}
      </p>
    );
  }
  return <>{children}</>;
}

interface PlotProps {
  renderer: Renderer;
  repo: RepositoryStatusJson;
  graph: GraphJson | undefined;
  now: number;
  selectedOid: string | null;
  onFocus: () => void;
  onSelect: (oid: string) => void;
  onHover: (node: GraphNodeJson | null, event?: React.PointerEvent) => void;
  /** Fixed hillside slot, or null when plots are laid out as cards. */
  slot: HillsideSlot | null;
}

const noHover = () => undefined;

function Plot({
  renderer,
  repo,
  graph,
  now,
  selectedOid,
  onFocus,
  onSelect,
  onHover,
  slot,
}: PlotProps) {
  const Drawing = renderer === "technical" ? GraphSvg : BotanicalGraph;
  const titleId = `plot-title-${repo.id}`;
  // Center the circular button over the tree's lanes, not over the text column.
  const buttonLeft = graph
    ? Math.max(4, PLOT_PADDING + graph.size.width / 2 - FOCUS_BUTTON / 2)
    : PLOT_PADDING;
  // On the hillside the plant grows from its slot, centered on its lanes.
  const lanes = graph?.size.width ?? 0;
  const sceneStyle = slot
    ? ({
        "--slot-x": `${String(slot.x)}%`,
        "--slot-y": `${String(slot.y)}%`,
        "--icon-x": `${String(slot.iconX)}%`,
        "--icon-y": `${String(slot.iconY)}%`,
        "--plant-scale": String(slot.scale),
        "--plant-z": String(Math.round(slot.y * 10)),
        "--anchor-x": `${String(lanes / 2)}px`,
        "--hit-w": `${String(lanes + 16)}px`,
      } as CSSProperties)
    : undefined;
  const state = repo.status.state;
  return (
    <section
      className={`plot${slot && (state === "stale" || state === "incomplete") ? " wilting" : ""}${slot && slot.iconX >= 60 ? " cards-left" : ""}`}
      data-plot={repo.id}
      tabIndex={0}
      aria-labelledby={titleId}
      style={sceneStyle}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          // Stop this keystroke here: focus moves to the "−" button, which
          // would otherwise receive the same Enter and immediately exit.
          event.preventDefault();
          onFocus();
        }
      }}
    >
      <button
        type="button"
        className="focus-button"
        aria-label={`Focus ${repo.label}`}
        style={slot ? undefined : { left: buttonLeft }}
        onClick={onFocus}
      >
        <span aria-hidden="true">+</span>
      </button>
      <div className="plot-card">
        <h2 id={titleId}>{repo.label}</h2>
        <StatusLine repo={repo} graph={graph} now={now} />
      </div>
      {/* On the hillside a plant is one target: clicking any part focuses it. */}
      <div className="plant" onClick={slot ? onFocus : undefined}>
        {slot && (
          <PlantMarker
            repo={repo}
            empty={repo.counts?.reachableCommits === 0}
            center={lanes / 2}
          />
        )}
        <PlotBody repo={repo} graph={graph}>
          {graph && (
            <div className="plot-graph">
              <Drawing
                compositor={renderer === "svg" ? "svg" : "canvas"}
                graph={graph}
                label={repo.label}
                selectedOid={selectedOid}
                onHover={slot ? noHover : onHover}
                onSelect={slot ? onFocus : onSelect}
              />
            </div>
          )}
        </PlotBody>
      </div>
    </section>
  );
}

/**
 * Garden-view health without text (roadmap section 7, "Overview in the garden
 * renderer"). Names and status stay hover/focus-only so the unattended scene
 * reads as a natural garden; problems are still visible at a glance:
 * - a soil bed only for a repository with no commits at all, so an empty
 *   plot looks intentional (maintainer decision: otherwise the plant's heads
 *   and stems represent it, with no placeholder);
 * - a marker stake carrying the state's glyph (never color alone) for any
 *   state other than healthy, including an unreachable remote, so an
 *   unreadable repository with nothing to draw is still never invisible.
 * Stale and incomplete plants are also desaturated (see .plot.wilting).
 */
function PlantMarker({
  repo,
  empty,
  center,
}: {
  repo: RepositoryStatusJson;
  /** The repository has no commits at all. */
  empty: boolean;
  /** Horizontal center of the tree's lanes, in the plot's coordinates. */
  center: number;
}) {
  const state = repo.status.state;
  const remoteDown = repo.remote?.state === "error";
  const glyph =
    state !== "ready" ? STATE_TEXT[state].glyph : remoteDown ? "⊘" : null;
  if (!empty && glyph === null) return null;
  return (
    <div
      className={`plant-marker marker-${state}${remoteDown ? " marker-remote-down" : ""}${empty ? " with-bed" : ""}`}
      style={{ left: center }}
      data-state={state}
      aria-hidden="true"
    >
      {empty && <span className="plant-bed" />}
      {glyph !== null && (
        <span className="plant-stake">
          <span className="stake-tag">{glyph}</span>
        </span>
      )}
    </div>
  );
}

const RENDERER_KEY = "git-flower-garden.renderer";
/** The key under the project's former name, read when the new one is unset. */
const LEGACY_RENDERER_KEY = "git-garden.renderer";

function loadRenderer(): Renderer {
  try {
    const saved =
      window.localStorage.getItem(RENDERER_KEY) ??
      window.localStorage.getItem(LEGACY_RENDERER_KEY);
    return saved === "canvas" || saved === "svg" ? saved : "technical";
  } catch {
    return "technical";
  }
}

function saveRenderer(renderer: Renderer): void {
  try {
    window.localStorage.setItem(RENDERER_KEY, renderer);
  } catch {
    // Storage may be unavailable (private windows); the choice lasts this visit.
  }
}

interface FocusViewProps {
  renderer: Renderer;
  repo: RepositoryStatusJson;
  graph: GraphJson | undefined;
  timeZone: string;
  now: number;
  selection: Selection | null;
  onSelect: (oid: string) => void;
  onCloseDetails: () => void;
  onHover: (node: GraphNodeJson | null, event?: React.PointerEvent) => void;
  onExit: () => void;
}

function FocusView(props: FocusViewProps) {
  const { repo, graph, selection, now } = props;
  const selectedOid = selection?.repoId === repo.id ? selection.oid : null;
  const exitButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    exitButton.current?.focus();
  }, []);
  return (
    <main className="focus" aria-label={`${repo.label}, focused`}>
      <div className="focus-main">
        <div className="focus-head">
          <h2>{repo.label}</h2>
          <StatusLine repo={repo} graph={graph} now={now} />
        </div>
        <PlotBody repo={repo} graph={graph}>
          {graph && (
            <FocusGraph
              renderer={props.renderer}
              graph={graph}
              label={repo.label}
              selectedOid={selectedOid}
              onHover={props.onHover}
              onSelect={props.onSelect}
              exitButton={
                <button
                  ref={exitButton}
                  type="button"
                  className="focus-button visible"
                  aria-label="Show all repositories"
                  onClick={props.onExit}
                >
                  <span aria-hidden="true">−</span>
                </button>
              }
            />
          )}
        </PlotBody>
        {/* Nothing drawn (unreadable or empty): the exit control stands alone. */}
        {(!graph || repo.counts?.reachableCommits === 0) && (
          <button
            ref={exitButton}
            type="button"
            className="focus-button visible static"
            aria-label="Show all repositories"
            onClick={props.onExit}
          >
            <span aria-hidden="true">−</span>
          </button>
        )}
      </div>
      <div className="focus-side">
        {selectedOid && (
          <Details
            graph={graph}
            repoLabel={repo.label}
            oid={selectedOid}
            timeZone={props.timeZone}
            onClose={props.onCloseDetails}
            onSelect={props.onSelect}
          />
        )}
        {graph && (
          <nav
            className="commit-list"
            aria-label={`Commits in ${repo.label}, newest first`}
          >
            <h3>Commits</h3>
            <ol>
              {graph.nodes
                .slice()
                .sort((a, b) => b.row - a.row)
                .map((n) => (
                  <li key={n.oid}>
                    <button
                      type="button"
                      aria-pressed={n.oid === selectedOid}
                      onClick={() => {
                        props.onSelect(n.oid);
                      }}
                    >
                      {describeNode(n)}
                    </button>
                  </li>
                ))}
            </ol>
          </nav>
        )}
      </div>
    </main>
  );
}

function Legend() {
  return (
    <details className="legend">
      <summary>Legend</summary>
      <ul>
        <li>
          <svg width="24" height="24" aria-hidden="true">
            <circle className="node head" cx="12" cy="12" r="7" />
            <circle className="ring" cx="12" cy="12" r="10" />
          </svg>
          Branch head
        </li>
        <li>
          <svg width="24" height="24" aria-hidden="true">
            <circle className="node recent" cx="12" cy="12" r="5" />
          </svg>
          Recent commit
        </li>
        <li>
          <svg width="24" height="24" aria-hidden="true">
            <path className="node ancestor" d="M12 5 L19 12 L12 19 L5 12 Z" />
          </svg>
          Common ancestor of branches
        </li>
        <li>
          <svg width="24" height="24" aria-hidden="true">
            <rect className="worktree" x="8" y="8" width="8" height="8" />
          </svg>
          Checked out in a worktree
        </li>
        <li>
          <svg width="40" height="24" aria-hidden="true">
            <line className="edge" x1="2" y1="12" x2="38" y2="12" />
          </svg>
          Parent
        </li>
        <li>
          <svg width="40" height="24" aria-hidden="true">
            <line className="edge collapsed" x1="2" y1="12" x2="38" y2="12" />
          </svg>
          Hidden ancestry; the badge counts hidden commits (… means several
          paths)
        </li>
        <li>
          <svg width="40" height="24" aria-hidden="true">
            <line
              className="tail-line boundary"
              x1="2"
              y1="12"
              x2="38"
              y2="12"
            />
          </svg>
          Missing history (shallow clone or unavailable objects)
        </li>
      </ul>
      <p>Older commits are lower. Each row is one commit.</p>
    </details>
  );
}

export { graphWidth };
