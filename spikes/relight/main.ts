/**
 * ADR 0018 step 2: a throwaway page comparing WebGL2 relighting with Canvas
 * 2D keyframes on the same art, lighting model, and sky. Not shipped.
 */
import { environmentSnapshot } from "../../src/environment/environment.ts";
import {
  lightingState,
  type LightingState,
} from "../../src/environment/lighting.ts";
import {
  PREVIEWS,
  PREVIEW_NAMES,
  isPreviewName,
  previewSnapshot,
} from "../../src/environment/overrides.ts";
import { loadLayer, type NormalSource } from "./art.ts";
import { GpuTier, type Art, type Options } from "./gpu.ts";
import { KEYFRAMES } from "./scene.ts";
import { SoftwareTier } from "./software.ts";

const art = (name: string) => new URL(`./art/${name}`, import.meta.url).href;

type View = "split" | "gpu" | "software";

function $<T extends HTMLElement>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`missing ${selector}`);
  return element;
}

const gpuCanvas = $("#gpu", HTMLCanvasElement);
const softwareCanvas = $("#software", HTMLCanvasElement);
const status = $("#status", HTMLElement);
const stats = $("#stats", HTMLElement);
const readout = $("#readout", HTMLElement);
const divider = $("#divider", HTMLElement);
const skySelect = $("#sky", HTMLSelectElement);
const dateInput = $("#date", HTMLInputElement);
const timeInput = $("#time", HTMLInputElement);
const timeLabel = $("#time-label", HTMLElement);
const playButton = $("#play", HTMLButtonElement);
const normalsSelect = $("#normals", HTMLSelectElement);
const inspectInput = $("#inspect", HTMLInputElement);
const modeSelect = $("#mode", HTMLSelectElement);
const sideSelect = $("#side", HTMLSelectElement);

const BLUE_RIDGE = {
  latitude: 35.5951,
  longitude: -82.5515,
  elevationMeters: 650,
};
const ZONE = "America/New_York";

const params = new URLSearchParams(location.search);
let view: View =
  (["split", "gpu", "software"] as const).find(
    (v) => v === params.get("view"),
  ) ?? "split";
let split = 0.5;
let playing = false;
let dirty = true;

for (const name of PREVIEW_NAMES) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = PREVIEWS[name].label;
  skySelect.append(option);
}
const initialSky = params.get("sky") ?? "custom";
skySelect.value = isPreviewName(initialSky) ? initialSky : "custom";
dateInput.value = params.get("date") ?? "2024-10-15";
timeInput.value = params.get("minutes") ?? String(8 * 60);
normalsSelect.value = params.get("normals") === "codex" ? "codex" : "derived";
inspectInput.checked = params.get("inspect") === "1";
modeSelect.value = params.get("mode") ?? "lit";
sideSelect.value = params.get("side") === "viewer" ? "viewer" : "physical";
if (params.get("ui") === "0") document.body.classList.add("bare");

function currentState(): LightingState {
  const sky = skySelect.value;
  if (isPreviewName(sky)) return lightingState(previewSnapshot(sky));
  const minutes = Number(timeInput.value);
  const [y, m, d] = dateInput.value.split("-").map(Number);
  // Local wall-clock minutes in New York, via the zone's offset at noon.
  const noonUtc = Date.UTC(y ?? 2024, (m ?? 1) - 1, d ?? 1, 17);
  const offset = new Date(noonUtc).toLocaleString("en-US", {
    timeZone: ZONE,
    timeZoneName: "shortOffset",
  });
  const hours = Number(/GMT([+-]\d+)/.exec(offset)?.[1] ?? "-5");
  const time = new Date(
    Date.UTC(y ?? 2024, (m ?? 1) - 1, d ?? 1) + (minutes - hours * 60) * 60_000,
  );
  return lightingState(environmentSnapshot(time, BLUE_RIDGE, ZONE));
}

function describe(state: LightingState): string {
  const sky = skySelect.value;
  const when = isPreviewName(sky)
    ? `Preview · ${PREVIEWS[sky].label}`
    : "Custom, Blue Ridge";
  return `${when} · ${state.twilight} · sun ${state.sun.altitude.toFixed(1)}° at u ${state.sun.u.toFixed(2)}${state.sun.behind ? " (behind)" : ""} · moon ${state.moon.altitude.toFixed(0)}°, ${String(Math.round(state.moon.illuminatedFraction * 100))}%`;
}

function layout(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const canvas of [gpuCanvas, softwareCanvas]) {
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  document.body.dataset.view = view;
  const edge = `${(split * 100).toFixed(2)}%`;
  softwareCanvas.style.clipPath =
    view === "split" ? `inset(0 0 0 ${edge})` : "";
  divider.style.left = edge;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-view]",
  ))
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  timeLabel.textContent = `${String(Math.floor(Number(timeInput.value) / 60)).padStart(2, "0")}:${String(Number(timeInput.value) % 60).padStart(2, "0")}`;
  const custom = skySelect.value === "custom";
  dateInput.disabled = !custom;
  timeInput.disabled = !custom;
  dirty = true;
}

interface Timing {
  frames: number;
  gpu: number;
  software: number;
  since: number;
  fps: number;
  gpuMs: number;
  softwareMs: number;
}
const timing: Timing = {
  frames: 0,
  gpu: 0,
  software: 0,
  since: performance.now(),
  fps: 0,
  gpuMs: 0,
  softwareMs: 0,
};

async function main(): Promise<void> {
  status.textContent = "Loading art and deriving normal maps…";
  const [ridge, hill, sprites] = await Promise.all([
    loadLayer(
      art("ridge-albedo.png"),
      { url: art("ridge-normal-codex.png") },
      { radius: 40, detail: 6 },
    ),
    loadLayer(
      art("hill-albedo.png"),
      { url: art("hill-normal-codex.png"), flipX: true },
      { radius: 260, detail: 4 },
    ),
    loadLayer(
      art("sprites-albedo.png"),
      { url: art("sprites-normal-codex.png") },
      { radius: 70, detail: 14 },
    ),
  ]);
  const scene: Art = { ridge, hill, sprites };

  let gpu: GpuTier | null = null;
  try {
    // ?softgl=1 accepts software WebGL, for headless screenshots only.
    gpu = GpuTier.create(gpuCanvas, scene, params.get("softgl") === "1");
  } catch (error) {
    console.error(error);
  }
  status.textContent = "Baking software keyframes…";
  await new Promise(requestAnimationFrame);
  const software = new SoftwareTier(softwareCanvas, scene);
  const renderer =
    gpu === null
      ? "WebGL2 unavailable (or software-only): GPU half is blank"
      : gpu.renderer;

  const options = (): Options => ({
    normals: normalsSelect.value as NormalSource,
    inspect: inspectInput.checked,
    mode:
      (["lit", "normals", "albedo"] as const).find(
        (m) => m === modeSelect.value,
      ) ?? "lit",
    side: sideSelect.value === "viewer" ? "viewer" : "physical",
  });

  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (playing) {
      // A day in 48 seconds.
      const minutes =
        (Number(timeInput.value) + ((now - last) / 48_000) * 1440) % 1440;
      timeInput.value = String(Math.floor(minutes));
      timeLabel.textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;
      dirty = true;
    }
    last = now;
    if (!dirty || document.hidden) return;
    dirty = false;
    const state = currentState();
    const o = options();
    if (view !== "software" && gpu !== null) {
      const start = performance.now();
      gpu.draw(state, o);
      timing.gpu += performance.now() - start;
    }
    if (view !== "gpu") {
      const start = performance.now();
      software.draw(state, o);
      timing.software += performance.now() - start;
    }
    timing.frames++;
    readout.textContent = describe(state);
    if (now - timing.since > 1000 || !playing) {
      const seconds = (now - timing.since) / 1000;
      timing.fps = playing ? timing.frames / seconds : 0;
      timing.gpuMs = timing.gpu / timing.frames;
      timing.softwareMs = timing.software / timing.frames;
      timing.frames = 0;
      timing.gpu = 0;
      timing.software = 0;
      timing.since = now;
      stats.textContent = [
        `${String(gpuCanvas.width)}×${String(gpuCanvas.height)} px`,
        renderer,
        `GPU draw ${timing.gpuMs.toFixed(1)} ms (CPU side)`,
        `Software draw ${timing.softwareMs.toFixed(1)} ms, last rebuild ${software.rebuildMs.toFixed(0)} ms (${String(software.rebuilds)} total), keyframe bake ${software.bakeMs.toFixed(0)} ms`,
        playing ? `${timing.fps.toFixed(0)} fps` : "idle: draws only on change",
      ].join(" · ");
    }
  };
  status.textContent = "";
  document.body.classList.add("ready");
  requestAnimationFrame(frame);
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-view]",
))
  button.addEventListener("click", () => {
    view = button.dataset.view as View;
    layout();
  });
for (const input of [
  skySelect,
  dateInput,
  timeInput,
  normalsSelect,
  inspectInput,
  modeSelect,
  sideSelect,
])
  input.addEventListener("input", layout);
playButton.addEventListener("click", () => {
  playing = !playing;
  if (playing) skySelect.value = "custom";
  playButton.textContent = playing ? "Pause" : "Play a day";
  layout();
});
window.addEventListener("resize", layout);
document.addEventListener("visibilitychange", () => (dirty = true));

let dragging = false;
divider.addEventListener("pointerdown", (event) => {
  dragging = true;
  divider.setPointerCapture(event.pointerId);
});
divider.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  split = Math.min(0.98, Math.max(0.02, event.clientX / window.innerWidth));
  layout();
});
divider.addEventListener("pointerup", () => (dragging = false));

window.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const keys: Record<string, () => void> = {
    "1": () => (view = "split"),
    "2": () => (view = "gpu"),
    "3": () => (view = "software"),
    // Flip between tiers full-screen: the quickest way to see a difference.
    x: () => (view = view === "gpu" ? "software" : "gpu"),
    h: () => {
      document.body.classList.toggle("bare");
    },
    n: () =>
      (normalsSelect.value =
        normalsSelect.value === "codex" ? "derived" : "codex"),
    i: () => (inspectInput.checked = !inspectInput.checked),
    l: () =>
      (sideSelect.value =
        sideSelect.value === "viewer" ? "physical" : "viewer"),
    " ": () => {
      playButton.click();
    },
    ArrowRight: () =>
      (timeInput.value = String((Number(timeInput.value) + 10) % 1440)),
    ArrowLeft: () =>
      (timeInput.value = String((Number(timeInput.value) + 1430) % 1440)),
  };
  const action = keys[event.key];
  if (action === undefined) return;
  event.preventDefault();
  if (event.key.startsWith("Arrow")) skySelect.value = "custom";
  action();
  layout();
});

$("#keyframes", HTMLElement).textContent = KEYFRAMES.map(
  (k) => `${k.name} ${k.time}`,
).join(", ");
layout();
main().catch((error: unknown) => {
  status.textContent = `Failed: ${String(error)}`;
  console.error(error);
});
