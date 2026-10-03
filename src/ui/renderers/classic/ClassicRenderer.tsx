/**
 * The classic renderers (ADR 0022): the technical graph and the hillside
 * garden, drawn with either compositor (ADR 0015, 0018). They share plots,
 * the focus view, and interactions, so all three are one component with a
 * mode. The garden's drawing engine lives in ../../scene/ and the modules
 * beside it (botanical.ts, GardenCanvas.tsx, SceneCanvas.tsx, ...).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  GraphJson,
  GraphNodeJson,
  RemoteStatusJson,
  RepositoryStatusJson,
} from "../../../api/types.ts";
import { Details } from "../../Details.tsx";
import { BotanicalGraph } from "../../BotanicalGraph.tsx";
import type { Renderer } from "../../botanical.ts";
import { FocusGraph } from "../../FocusGraph.tsx";
import {
  describeNode,
  durationText,
  relativeTime,
  STATE_TEXT,
} from "../../format.ts";
import { GraphSvg } from "../../GraphSvg.tsx";
import {
  QUALITIES,
  setQuality,
  setTier,
  TIERS,
  useMotionHold,
  useQuality,
  useTier,
  type MotionHold,
  type Quality,
  type Tier,
} from "../../motion.ts";
import {
  HILLSIDE_SLOTS,
  hillsideSlots,
  type HillsideSlot,
} from "../../hillside.ts";
import { SceneCanvas } from "../../SceneCanvas.tsx";
import { GardenCanvas } from "../../GardenCanvas.tsx";
import type { PlantInput } from "../../scene/description.ts";
import { WeatherOverlay } from "../../WeatherOverlay.tsx";
import { DESIGN } from "../../scene/view.ts";
import { repositoryHealth } from "../../viewmodel/garden.ts";
import type { RendererProps, Selection } from "../types.ts";

/** Offset of the plot's graph drawing inside its card, used to center the focus button over the tree. */
const PLOT_PADDING = 16;
export const FOCUS_BUTTON = 44;

/**
 * The classic renderers, one component for all three so a switch keeps the
 * focus camera and selection: `rendererId` picks the drawing.
 */
export function ClassicRenderer({
  rendererId,
  garden,
  environment,
  focusedId,
  onFocus,
  onExitFocus,
  selection,
  onSelect,
  onHover,
}: RendererProps) {
  const mode: Renderer =
    rendererId === "canvas" || rendererId === "svg" ? rendererId : "technical";
  const repos = garden.repositories;
  const focused = repos.find((r) => r.id === focusedId);
  // The hillside has 64 fixed plant slots; dense planting is intended (focus
  // view isolates one plant). Larger gardens use the card layout.
  const sceneMode =
    mode !== "technical" && repos.length <= HILLSIDE_SLOTS.length;
  const sceneSlots = sceneMode ? hillsideSlots(repos.length) : [];
  const slotOf = (index: number) =>
    sceneMode ? (HILLSIDE_SLOTS[sceneSlots[index] ?? 0] ?? null) : null;
  // With the Canvas compositor the hillside's art is one scene, drawn by
  // one canvas (ADR 0018); each plot keeps only its hit and label layer.
  const sceneDrawn = sceneMode && mode === "canvas";
  const plants = useMemo(() => {
    const list: PlantInput[] = [];
    if (!sceneDrawn) return list;
    for (const repo of repos) {
      const slot = slotOf(repo.index);
      if (!slot || !repo.drawable || !repo.graph) continue;
      list.push({
        id: repo.id,
        graph: repo.graph,
        slot,
        wilting: repo.health.wilting,
      });
    }
    return list;
    // slotOf depends only on sceneMode and the repository count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneDrawn, repos]);
  const stageScale = useStageScale();
  const shownLight = environment?.shownLight;

  return (
    <>
      {environment && (
        <div
          className="landscape"
          aria-hidden="true"
          data-sky={
            environment.sky
              ? (environment.sky.snapshot.preview ?? "live")
              : "day"
          }
        >
          <SceneCanvas
            state={environment.light}
            weather={environment.weather}
          />
          <div className="landscape-vignette" />
        </div>
      )}
      {focused ? (
        <FocusView
          renderer={mode}
          repo={focused.status}
          graph={focused.graph}
          timeZone={garden.timeZone}
          now={garden.now}
          selection={selection}
          onSelect={(oid) => {
            onSelect({ repoId: focused.id, oid });
          }}
          onCloseDetails={() => {
            onSelect(null);
          }}
          onHover={onHover}
          onExit={onExitFocus}
        />
      ) : (
        <main
          className={`garden${sceneMode ? " garden-scene" : ""}${sceneDrawn ? " scene-drawn" : ""}`}
          aria-label="All repositories"
          style={
            sceneMode
              ? ({ "--stage-scale": String(stageScale) } as CSSProperties)
              : undefined
          }
        >
          {/* The SVG compositor's plots draw their own plants, over the grass. */}
          {sceneMode && shownLight && (
            <GardenCanvas
              plants={plants}
              light={shownLight}
              grassOnly={!sceneDrawn}
            />
          )}
          {sceneMode && environment && (
            <WeatherOverlay
              light={environment.shownLight}
              effects={environment.effects}
            />
          )}
          {repos.map((repo) => (
            <Plot
              renderer={mode}
              key={repo.id}
              repo={repo.status}
              graph={repo.graph}
              now={garden.now}
              selectedOid={selection?.repoId === repo.id ? selection.oid : null}
              onFocus={() => {
                onFocus(repo.id);
              }}
              onSelect={(oid) => {
                onSelect({ repoId: repo.id, oid });
              }}
              onHover={onHover}
              slot={slotOf(repo.index)}
            />
          ))}
        </main>
      )}
    </>
  );
}

/** The garden's key: what the picture means, and why it may be still. */
export function GardenKey() {
  const hold = useMotionHold();
  return (
    <>
      {motionNote(hold)}
      <span className="art-key">
        Flowers = branch heads · leaves = commits · fruit = tags · gold markers
        = worktrees. Dashed stems hide history; red boundaries mean missing
        history.
      </span>
    </>
  );
}

/** The garden's own controls: how it is drawn, and how much it moves. */
export function GardenControls() {
  return (
    <>
      <TierControl />
      <QualityControl />
      <Legend />
    </>
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

/** Last-known state: the plant fades like a wilting one. */
function wilting(repo: RepositoryStatusJson): boolean {
  return repositoryHealth(repo).wilting;
}

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
  return (
    <section
      className={`plot${slot && wilting(repo) ? " wilting" : ""}${slot && slot.iconX >= 60 ? " cards-left" : ""}`}
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
                sway
                artless={slot !== null && renderer === "canvas"}
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
  const { state, remoteDown, marker: glyph } = repositoryHealth(repo);
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

const TIER_NAMES: Record<Tier, string> = {
  auto: "Auto",
  gpu: "GPU",
  software: "Software",
  static: "Static",
};

/**
 * How the garden is drawn (ADR 0018, "Choosing a tier"): Auto (the GPU on
 * graphics hardware, else Software), GPU (WebGL2, even in software),
 * Software (Canvas 2D), or Static (Canvas 2D, no motion between lighting
 * changes).
 */
export function TierControl() {
  const tier = useTier();
  return (
    <label className="preview-control">
      Drawing
      <select
        aria-label="Drawing"
        value={tier}
        onChange={(event) => {
          setTier(event.target.value as Tier);
        }}
      >
        {TIERS.map((value) => (
          <option key={value} value={value}>
            {TIER_NAMES[value]}
          </option>
        ))}
      </select>
    </label>
  );
}

const QUALITY_NAMES: Record<Quality, string> = {
  low: "Low",
  balanced: "Balanced",
  high: "High",
};

/**
 * How much the garden animates and how sharply it is drawn (ADR 0018 step
 * 6, scene/quality.ts): Low (10 fps, no sway, fewer particles, standard
 * resolution), Balanced (15 fps), or High (30 fps, the default).
 */
export function QualityControl() {
  const quality = useQuality();
  return (
    <label className="preview-control">
      Quality
      <select
        aria-label="Quality"
        value={quality}
        onChange={(event) => {
          setQuality(event.target.value as Quality);
        }}
      >
        {QUALITIES.map((value) => (
          <option key={value} value={value}>
            {QUALITY_NAMES[value]}
          </option>
        ))}
      </select>
    </label>
  );
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

export function Legend() {
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
/**
 * The stage's size relative to the 1920×1080 design space: how much the
 * plants scale so they keep their size on the landscape (styles.css).
 */
function useStageScale(): number {
  const [scale, setScale] = useState(measureStage);
  useEffect(() => {
    const update = () => {
      setScale(measureStage());
    };
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);
  return scale;
}

function measureStage(): number {
  return Math.min(
    window.innerWidth / DESIGN.width,
    window.innerHeight / DESIGN.height,
  );
}
/**
 * Why the garden is still when it would sway (motion.ts `motionHold`), so
 * a still garden is never a mystery; nothing when it moves as chosen.
 */
function motionNote(hold: MotionHold) {
  if (hold === null) return null;
  const text = {
    reduced:
      "Held still: reduced motion is on (on this device or in the configuration), so plants and grass do not sway.",
    stopped:
      "Sway stopped for this visit: frames ran late on this device. A lower Quality may keep it moving.",
    stepped:
      "Sway slowed to 15 frames a second: frames ran late at this Quality.",
  }[hold];
  return (
    <>
      <span className="motion-note" data-hold={hold}>
        {text}
      </span>{" "}
    </>
  );
}
