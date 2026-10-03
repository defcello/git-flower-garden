import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import type { LightingState } from "../environment/lighting.ts";
import type {
  GraphJson,
  GraphNodeJson,
  RemoteStatusJson,
  RepositoryStatusJson,
} from "../api/types.ts";
import { STATIC_DEMO, useGardenData } from "./api.ts";
import { Details } from "./Details.tsx";
import { FullscreenButton, useFullscreen } from "./Fullscreen.tsx";
import { BotanicalGraph } from "./BotanicalGraph.tsx";
import type { Renderer } from "./botanical.ts";
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
} from "./motion.ts";
import {
  HILLSIDE_SLOTS,
  hillsideSlots,
  type HillsideSlot,
} from "./hillside.ts";
import { SceneCanvas } from "./SceneCanvas.tsx";
import { GardenCanvas } from "./GardenCanvas.tsx";
import type { PlantInput } from "./scene/description.ts";
import { useShownLight } from "./scene/client.ts";
import { WeatherNote } from "./WeatherNote.tsx";
import {
  applyWind,
  describeWind,
  WEATHER_WIND,
  WindControls,
  type WindSetting,
} from "./WindControls.tsx";
import { WeatherOverlay } from "./WeatherOverlay.tsx";
import { setSwayWind } from "./sway.ts";
import {
  NO_WEATHER,
  rainbow,
  weatherEffects,
  weatherLighting,
} from "../environment/weather-effects.ts";
import {
  previewConditions,
  WEATHER_PREVIEWS,
  WEATHER_PREVIEW_NAMES,
  type WeatherPreviewName,
} from "../environment/weather-previews.ts";
import { SkyControls } from "./SkyControls.tsx";
import { DAYTIME, DESIGN, plantShadowStyle } from "./scene/view.ts";
import {
  LIVE,
  describeSky,
  useSky,
  useSkyLoop,
  type SkySetting,
} from "./sky.ts";

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

const NO_REPOSITORIES: RepositoryStatusJson[] = [];

export function App() {
  const { repositories, graphs, connectionError, fetchedAt } = useGardenData();
  // The technical view stays the default until the garden is accepted; a
  // viewer's own choice is remembered in this browser only.
  const [renderer, setRenderer] = useState<Renderer>(loadRenderer);
  const [skySetting, setSkySetting] = useState<SkySetting>(LIVE);
  const [weatherSetting, setWeatherSetting] = useState<
    "live" | WeatherPreviewName
  >("live");
  const [looping, setLooping] = useState(false);
  const [wind, setWind] = useState<WindSetting>(WEATHER_WIND);
  useSkyLoop(looping && renderer !== "technical", setSkySetting);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const gardenReturn = useRef<{ scrollY: number; plotId: string } | null>(null);

  const repos = repositories?.repositories ?? NO_REPOSITORIES;
  const timeZone = repositories?.display.timeZone ?? "UTC";
  const focused = repos.find((r) => r.id === focusedId);
  const environment = repositories?.display.environment ?? null;
  const sky = useSky(
    renderer !== "technical" ? environment : null,
    renderer !== "technical" ? skySetting : LIVE,
  );
  // The hillside has 64 fixed plant slots; dense planting is intended (focus
  // view isolates one plant). Larger gardens use the card layout.
  const sceneMode =
    renderer !== "technical" && repos.length <= HILLSIDE_SLOTS.length;
  const sceneSlots = sceneMode ? hillsideSlots(repos.length) : [];
  const slotOf = (index: number) =>
    sceneMode ? (HILLSIDE_SLOTS[sceneSlots[index] ?? 0] ?? null) : null;
  // With the Canvas compositor the hillside's art is one scene, drawn by
  // one canvas (ADR 0018); each plot keeps only its hit and label layer.
  const sceneDrawn = sceneMode && renderer === "canvas";
  const plants = useMemo(() => {
    const list: PlantInput[] = [];
    if (!sceneDrawn) return list;
    const slots = hillsideSlots(repos.length);
    repos.forEach((repo, index) => {
      const graph = graphs.get(repo.id);
      const slot = HILLSIDE_SLOTS[slots[index] ?? 0];
      if (!graph || !slot || !drawsPlant(repo, graph)) return;
      list.push({ id: repo.id, graph, slot, wilting: wilting(repo) });
    });
    return list;
  }, [sceneDrawn, repos, graphs]);
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

  // Weather: live conditions with the live sky, or a developer preview;
  // none for a chosen time, which live conditions do not describe.
  const liveConditions =
    sky?.snapshot.source === "live"
      ? (environment?.weather?.conditions ?? null)
      : null;
  const skyTime = sky?.snapshot.time.getTime() ?? null;
  const previewHour =
    skyTime === null ? 0 : Math.floor(skyTime / 3_600_000) * 3_600_000;
  // Every server message parses anew; the weather changes far less often.
  const liveKey = JSON.stringify(liveConditions);
  const forecast = useMemo(
    () =>
      renderer === "technical"
        ? NO_WEATHER
        : weatherSetting === "live"
          ? weatherEffects(liveConditions)
          : weatherEffects(previewConditions(weatherSetting, previewHour)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderer, weatherSetting, liveKey, previewHour],
  );
  // The wind controls replace the forecast's wind (WindControls.tsx).
  const effects = useMemo(
    () => (renderer === "technical" ? forecast : applyWind(forecast, wind)),
    [renderer, forecast, wind],
  );
  const skyMinutes = Math.floor((skyTime ?? 0) / 60_000);
  const skyWeather = useMemo(
    () => (effects === NO_WEATHER ? null : { effects, minutes: skyMinutes }),
    [effects, skyMinutes],
  );
  const baseLight = sky?.state ?? DAYTIME;
  const light = useMemo(
    () => weatherLighting(baseLight, effects),
    [baseLight, effects],
  );
  const showsRainbow = rainbow(light, effects) !== null;
  const hold = useMotionHold();
  useEffect(() => {
    setSwayWind(
      effects === NO_WEATHER ? null : effects.windSpeed,
      effects.windX,
      effects.windZ,
      effects.windGust,
    );
  }, [effects]);
  // Plant shadows change with the relit art, not ahead of it.
  const shownLight = useShownLight(light);
  // The top bar and notes float over the scene; the focus view and the
  // drawer start below them (styles.css --hud-height).
  const appRef = useHudHeight();
  const stageScale = useStageScale();
  const fullscreen = useFullscreen(appRef);

  return (
    <div
      ref={appRef}
      className={`app${renderer !== "technical" ? " botanical" : ""}${renderer !== "technical" && isNight(shownLight) ? " night" : ""}${fullscreen.active ? " fullscreen" : ""}`}
      style={
        renderer !== "technical" ? plantShadowStyle(shownLight) : undefined
      }
    >
      {renderer !== "technical" && (
        <div
          className="landscape"
          aria-hidden="true"
          data-sky={sky ? (sky.snapshot.preview ?? "live") : "day"}
        >
          <SceneCanvas state={light} weather={skyWeather} />
          <div className="landscape-vignette" />
        </div>
      )}
      <div className="hud">
        <header className="topbar">
          <h1>git-flower-garden</h1>
          {repositories && (
            <span className="summary">
              {repos.length}{" "}
              {repos.length === 1 ? "repository" : "repositories"} · last{" "}
              {repositories.display.businessDays} business days · {timeZone}
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
          {renderer !== "technical" && <TierControl />}
          {renderer !== "technical" && <QualityControl />}
          {renderer !== "technical" && (
            <SkyControls
              setting={skySetting}
              sky={sky}
              environment={environment}
              onChange={setSkySetting}
              looping={looping}
              onLoopingChange={setLooping}
            />
          )}
          {renderer !== "technical" && (
            <label className="preview-control">
              Weather
              <select
                aria-label="Weather"
                value={weatherSetting}
                onChange={(event) => {
                  setWeatherSetting(
                    event.target.value as "live" | WeatherPreviewName,
                  );
                }}
              >
                <option value="live">
                  {environment?.weather ? "Live" : "Live · weather off"}
                </option>
                {WEATHER_PREVIEW_NAMES.map((name) => (
                  <option key={name} value={name}>
                    Preview · {WEATHER_PREVIEWS[name].label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {renderer !== "technical" && (
            <WindControls
              setting={wind}
              effects={forecast}
              onChange={setWind}
            />
          )}
          <Legend />
        </header>
        <div className="hud-notes">
          {renderer !== "technical" && (
            <div className="art-notice" role="note">
              {sky?.snapshot.source === "preview" ? (
                <strong className="sky-preview-badge">Sky preview</strong>
              ) : null}{" "}
              Art preview ·{" "}
              {sky
                ? `${sky.snapshot.source === "preview" ? "not live conditions: " : "live sky, "}${describeSky(sky)}.`
                : "noon sky; the real sky is off (environment.enabled)."}{" "}
              {weatherSetting !== "live" ? (
                <>
                  <strong className="weather-preview-badge">
                    Weather preview
                  </strong>{" "}
                  not live weather: {WEATHER_PREVIEWS[weatherSetting].label}
                  .{" "}
                </>
              ) : sky?.snapshot.source === "live" && environment?.weather ? (
                <>
                  <WeatherNote
                    weather={environment.weather}
                    timeZone={environment.timeZone}
                  />{" "}
                </>
              ) : null}
              {describeWind(wind) !== null && (
                <>
                  <strong className="weather-preview-badge">
                    Wind preview
                  </strong>{" "}
                  {describeWind(wind)}{" "}
                </>
              )}
              {motionNote(hold)}
              {showsRainbow && (
                <>
                  The rainbow follows the optics of sunlit rain; it is inferred
                  from the forecast, not observed.{" "}
                </>
              )}
              <span className="art-key">
                Flowers = branch heads · leaves = commits · fruit = tags · gold
                markers = worktrees. Dashed stems hide history; red boundaries
                mean missing history.
              </span>
            </div>
          )}
          <div className="banners">
            {repositories?.display.notice && (
              <div className="banner notice" role="note">
                {repositories.display.notice}
              </div>
            )}
            {repositories && repositories.configErrors.length > 0 && (
              <div className="banner" role="alert">
                <strong>
                  The configuration file has problems; the last valid
                  configuration is still in use.
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
                {STATIC_DEMO
                  ? `Could not load the demo snapshot (${connectionError}).`
                  : `Live updates interrupted (${connectionError}). Showing the last known state.`}
              </div>
            )}
          </div>
        </div>
      </div>
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
          className={`garden${sceneMode ? " garden-scene" : ""}${sceneDrawn ? " scene-drawn" : ""}`}
          aria-label="All repositories"
          style={
            sceneMode
              ? ({ "--stage-scale": String(stageScale) } as CSSProperties)
              : undefined
          }
        >
          {/* The SVG compositor's plots draw their own plants, over the grass. */}
          {sceneMode && (
            <GardenCanvas
              plants={plants}
              light={shownLight}
              grassOnly={!sceneDrawn}
            />
          )}
          {sceneMode && <WeatherOverlay light={shownLight} effects={effects} />}
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
              slot={slotOf(index)}
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
      <FullscreenButton
        active={fullscreen.active}
        onToggle={fullscreen.toggle}
      />
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

/** Whether a plot draws a plant (PlotBody): a readable graph with commits. */
function drawsPlant(repo: RepositoryStatusJson, graph: GraphJson | undefined) {
  return graph !== undefined && repo.counts?.reachableCommits !== 0;
}

/** Last-known state: the plant fades like a wilting one. */
function wilting(repo: RepositoryStatusJson): boolean {
  return repo.status.state === "stale" || repo.status.state === "incomplete";
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
function TierControl() {
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
function QualityControl() {
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

const RENDERER_KEY = "git-flower-garden.renderer";
/** The key under the project's former name, read when the new one is unset. */
const LEGACY_RENDERER_KEY = "git-garden.renderer";

/** The demo opens on the garden; the installed service on the graph. */
const defaultRenderer: Renderer = STATIC_DEMO ? "canvas" : "technical";

function loadRenderer(): Renderer {
  try {
    const saved =
      window.localStorage.getItem(RENDERER_KEY) ??
      window.localStorage.getItem(LEGACY_RENDERER_KEY);
    return saved === "canvas" || saved === "svg" ? saved : defaultRenderer;
  } catch {
    return defaultRenderer;
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

/** After civil dusk: the panels over the scene turn dark (styles.css). */
function isNight(light: LightingState): boolean {
  return light.sun.altitude < -6;
}

/**
 * Publish the floating top area's height as --hud-height on the app, so
 * content below it (the focus view, the drawer) starts clear of it however
 * the top bar wraps.
 */
function useHudHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const app = ref.current;
    const hud = app?.querySelector(".hud");
    if (!app || !hud) return;
    const observer = new ResizeObserver(() => {
      app.style.setProperty(
        "--hud-height",
        `${String(Math.ceil(hud.getBoundingClientRect().height))}px`,
      );
    });
    observer.observe(hud);
    return () => {
      observer.disconnect();
    };
  }, []);
  return ref;
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
