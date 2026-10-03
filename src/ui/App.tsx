/**
 * The app shell (ADR 0022): it owns what every renderer shares (the Model,
 * the view models, the top bar, notices, the renderer choice, the sky and
 * weather controls, focus and selection state, the details drawer, and the
 * tooltip) and hands the view models to the chosen renderer to draw.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GraphNodeJson } from "../api/types.ts";
import { STATIC_DEMO, useGardenModel } from "./api.ts";
import { Details } from "./Details.tsx";
import { FullscreenButton, useFullscreen } from "./Fullscreen.tsx";
import { reasonText, shortOid } from "./format.ts";
import { WeatherNote } from "./WeatherNote.tsx";
import {
  WEATHER_PREVIEWS,
  WEATHER_PREVIEW_NAMES,
} from "../environment/weather-previews.ts";
import { SkyControls } from "./SkyControls.tsx";
import { LIVE, describeSky, useSkyLoop, type SkySetting } from "./sky.ts";
import { findRenderer, RENDERERS } from "./renderers/registry.ts";
import type { RendererDefinition, Selection } from "./renderers/types.ts";
import {
  useSceneEnvironment,
  type WeatherSetting,
} from "./shell/use-environment.ts";
import { gardenView } from "./viewmodel/garden.ts";

interface Hover {
  node: GraphNodeJson;
  x: number;
  y: number;
}

export function App() {
  const snapshot = useGardenModel();
  const garden = useMemo(() => gardenView(snapshot), [snapshot]);
  const { repositories, connectionError } = snapshot;
  const [chosen, setChosen] = useState<string | null>(initialRenderer);
  const definition = activeRenderer(chosen, repositories?.display.renderer);
  const usesEnvironment = definition.usesEnvironment;
  const [skySetting, setSkySetting] = useState<SkySetting>(LIVE);
  const [weatherSetting, setWeatherSetting] = useState<WeatherSetting>("live");
  const [looping, setLooping] = useState(false);
  useSkyLoop(looping && usesEnvironment, setSkySetting);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const gardenReturn = useRef<{ scrollY: number; plotId: string } | null>(null);

  const repos = garden.repositories;
  const environmentJson = repositories?.display.environment ?? null;
  const environment = useSceneEnvironment(
    usesEnvironment,
    environmentJson,
    skySetting,
    weatherSetting,
  );
  const sky = environment?.sky ?? null;
  // A focused repository that disappears from the configuration shows the garden.
  const activeFocusId = repos.some((r) => r.id === focusedId)
    ? focusedId
    : null;

  useEffect(() => {
    document.documentElement.classList.toggle(
      "reduce-motion",
      garden.reducedMotion,
    );
  }, [garden.reducedMotion]);

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

  const selectedRepo = selection
    ? repos.find((r) => r.id === selection.repoId)
    : undefined;
  // The top bar and notes float over the scene; the focus view and the
  // drawer start below them (styles.css --hud-height).
  const appRef = useHudHeight();
  const fullscreen = useFullscreen(appRef);
  const scene = definition.layout === "scene";
  const { Component, Controls, Key } = definition;
  const drawer =
    selection !== null &&
    !(activeFocusId !== null && definition.ownsFocusDetails === true);

  return (
    <div
      ref={appRef}
      className={`app${scene ? " botanical" : ""}${scene && environment?.night === true ? " night" : ""}${fullscreen.active ? " fullscreen" : ""}`}
      data-renderer={definition.id}
      style={
        environment && definition.rootStyle
          ? definition.rootStyle(environment)
          : undefined
      }
    >
      <div className="hud">
        <header className="topbar">
          <h1>git-flower-garden</h1>
          {repositories && (
            <span className="summary">
              {repos.length}{" "}
              {repos.length === 1 ? "repository" : "repositories"} · last{" "}
              {garden.businessDays} business days · {garden.timeZone}
            </span>
          )}
          <label className="preview-control">
            View
            <select
              aria-label="Renderer"
              value={definition.id}
              onChange={(event) => {
                setChosen(event.target.value);
                saveRenderer(event.target.value);
              }}
            >
              {RENDERERS.map((renderer) => (
                <option
                  key={renderer.id}
                  value={renderer.id}
                  title={renderer.description}
                >
                  {renderer.label}
                </option>
              ))}
            </select>
          </label>
          {Controls && <Controls />}
          {usesEnvironment && (
            <SkyControls
              setting={skySetting}
              sky={sky}
              environment={environmentJson}
              onChange={setSkySetting}
              looping={looping}
              onLoopingChange={setLooping}
            />
          )}
          {usesEnvironment && (
            <label className="preview-control">
              Weather
              <select
                aria-label="Weather"
                value={weatherSetting}
                onChange={(event) => {
                  setWeatherSetting(event.target.value as WeatherSetting);
                }}
              >
                <option value="live">
                  {environmentJson?.weather ? "Live" : "Live · weather off"}
                </option>
                {WEATHER_PREVIEW_NAMES.map((name) => (
                  <option key={name} value={name}>
                    Preview · {WEATHER_PREVIEWS[name].label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
        <div className="hud-notes">
          {usesEnvironment && (
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
              ) : sky?.snapshot.source === "live" &&
                environmentJson?.weather ? (
                <>
                  <WeatherNote
                    weather={environmentJson.weather}
                    timeZone={environmentJson.timeZone}
                  />{" "}
                </>
              ) : null}
              {environment?.rainbow === true && (
                <>
                  The rainbow follows the optics of sunlit rain; it is inferred
                  from the forecast, not observed.{" "}
                </>
              )}
              {Key && <Key environment={environment} />}
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
      {garden.phase === "loading" ? (
        <p className="loading" role="status">
          Loading…
        </p>
      ) : garden.phase === "empty" ? (
        <div className="welcome">
          <h2>No repositories are configured yet</h2>
          <p>
            Add entries to <code>repositories</code> in your configuration file,
            check it with <code>git-flower-garden validate-config</code>, then
            restart the service.
          </p>
        </div>
      ) : (
        <Component
          rendererId={definition.id}
          garden={garden}
          environment={environment}
          focusedId={activeFocusId}
          onFocus={enterFocus}
          onExitFocus={exitFocus}
          selection={selection}
          onSelect={setSelection}
          onHover={onHover}
        />
      )}
      {drawer && (
        <div className="drawer">
          <Details
            graph={selectedRepo?.graph}
            repoLabel={selectedRepo?.label ?? selection.repoId}
            oid={selection.oid}
            timeZone={garden.timeZone}
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

const RENDERER_KEY = "git-flower-garden.renderer";
/** The key under the project's former name, read when the new one is unset. */
const LEGACY_RENDERER_KEY = "git-garden.renderer";

/**
 * The viewer's own choice, if any: `?renderer=<id>` for this visit, else the
 * one remembered in this browser. Unknown ids are ignored.
 */
function initialRenderer(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("renderer");
  if (findRenderer(fromUrl)) return fromUrl;
  try {
    const saved =
      window.localStorage.getItem(RENDERER_KEY) ??
      window.localStorage.getItem(LEGACY_RENDERER_KEY);
    return findRenderer(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * The viewer's choice, else the configuration's `display.renderer`, else
 * the build's default: the demo opens on the garden, the installed service
 * on the technical graph.
 */
function activeRenderer(
  chosen: string | null,
  configured: string | undefined,
): RendererDefinition {
  return (
    findRenderer(chosen) ??
    (STATIC_DEMO ? undefined : findRenderer(configured)) ??
    findRenderer(STATIC_DEMO ? "canvas" : "technical") ??
    (RENDERERS[0] as RendererDefinition)
  );
}

function saveRenderer(renderer: string): void {
  try {
    window.localStorage.setItem(RENDERER_KEY, renderer);
  } catch {
    // Storage may be unavailable (private windows); the choice lasts this visit.
  }
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
