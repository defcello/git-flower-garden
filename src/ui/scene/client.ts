/**
 * The page's one relighting worker and the latest lit art (ADR 0018, step
 * 3), on two channels:
 *
 * - "scene": the whole landscape and the hillside plants, lit by the
 *   current sky; only the plants' sprites when the GPU tier draws the
 *   landscape, and nothing when it draws the plants too;
 * - "inspection": the sprites alone, lit once by `DAYTIME`, for the focus
 *   view's pale inspection card, where a dusk- or moonlit plant would be
 *   dark and hard to read.
 *
 * The last lit art stays on screen while a newer light is being computed,
 * so nothing flickers.
 */
import { useEffect, useSyncExternalStore } from "react";
import hillAlbedo from "../assets/scene/hill-albedo.png";
import hillNormal from "../assets/scene/hill-normal.png";
import hillTranslucency from "../assets/scene/hill-translucency.png";
import ridgeAlbedo from "../assets/scene/ridge-albedo.png";
import ridgeNormal from "../assets/scene/ridge-normal.png";
import spritesAlbedo from "../assets/scene/sprites-albedo.png";
import spritesNormal from "../assets/scene/sprites-normal.png";
import spritesTranslucency from "../assets/scene/sprites-translucency.png";
import grassAlbedo from "../assets/scene/grass-albedo.png";
import grassNormal from "../assets/scene/grass-normal.png";
import grassTranslucency from "../assets/scene/grass-translucency.png";
import {
  BOUNDARY_COLOR,
  HALO_COLOR,
  KNOT_COLOR,
  STEM_COLOR,
} from "../botanical.ts";
import type { LitBitmaps, WorkerRequest, WorkerResponse } from "./protocol.ts";
import type { LightingState } from "../../environment/lighting.ts";
import type { LightParams } from "./shading.ts";
import { DAYTIME, lightKey, litColor, sceneLight } from "./view.ts";

export type Channel = "scene" | "inspection";

export interface LitArt extends LitBitmaps {
  /** The light it was lit with (view.ts `lightKey`). */
  key: string;
  /** Only the sprites were lit: ridge and hill are null. */
  spritesOnly: boolean;
  /**
   * The lighting state it was lit for. Everything else in the scene (sky,
   * Sun, Moon, stars, shadows) is drawn from this, not from the newest
   * request, so a frame never mixes two times of day.
   */
  light: LightingState;
  /** Object URLs of the sprite atlases, for the SVG compositor. */
  spritesUrl: string;
  spritesMirroredUrl: string;
  /** Procedural plant colors (botanical.ts) lit the same way, by their unlit value. */
  palette: Record<string, string>;
  /** Milliseconds the worker spent lighting texels. */
  lightMs: number;
}

export type SceneArt =
  | { state: "loading" }
  | { state: "ready"; art: LitArt }
  | { state: "failed"; reason: string };

const snapshots: Record<Channel, SceneArt> = {
  scene: { state: "loading" },
  inspection: { state: "loading" },
};
/** The light last asked for on each channel. */
const wanted: Record<Channel, string> = { scene: "", inspection: "" };
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let nextId = 1;
interface Request {
  params: LightParams;
  light: LightingState;
  spritesOnly: boolean;
}
const pending = new Map<number, { channel: Channel; key: string } & Request>();
/**
 * One relight in flight per channel; while it runs, only the newest light
 * asked for waits. Dragging the time of day never queues a backlog of
 * relights: the scene catches up with the slider, one relight behind.
 */
const inFlight: Record<Channel, boolean> = { scene: false, inspection: false };
const queued: Record<Channel, Request | null> = {
  scene: null,
  inspection: null,
};

function closeAll(b: LitBitmaps) {
  for (const bitmap of [
    b.ridge,
    b.hill,
    b.sprites,
    b.spritesMirrored,
    b.grass,
    b.grassMirrored,
  ])
    bitmap?.close();
}

function release(art: LitArt) {
  closeAll(art);
  URL.revokeObjectURL(art.spritesUrl);
  URL.revokeObjectURL(art.spritesMirroredUrl);
}

function publish(channel: Channel, next: SceneArt) {
  const previous = snapshots[channel];
  snapshots[channel] = next;
  for (const listener of listeners) listener();
  if (previous.state === "ready") {
    // Release replaced bitmaps once every consumer has redrawn with the
    // new ones; a redraw already queued may still hold the old art.
    const old = previous.art;
    setTimeout(() => {
      release(old);
    }, 2000);
  }
}

function fail(reason: string) {
  worker?.terminate();
  for (const channel of ["scene", "inspection"] as const)
    publish(channel, { state: "failed", reason });
}

function received(message: WorkerResponse) {
  if (message.type === "error") {
    fail(message.message);
    return;
  }
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (request !== undefined) {
    inFlight[request.channel] = false;
    const next = queued[request.channel];
    queued[request.channel] = null;
    if (next !== null) post(request.channel, next);
  }
  const current = request ? snapshots[request.channel] : null;
  // Never replace newer art with older (a later light was asked for).
  if (
    request === undefined ||
    current === null ||
    current.state === "failed" ||
    (current.state === "ready" &&
      artKey(current.art.light, current.art.spritesOnly) ===
        wanted[request.channel])
  ) {
    closeAll(message.bitmaps);
    return;
  }
  // Short object URLs, not data URLs: every sprite <image> repeats its href.
  const spritesUrl = URL.createObjectURL(message.png.sprites);
  const spritesMirroredUrl = URL.createObjectURL(message.png.spritesMirrored);
  const palette = Object.fromEntries(
    [STEM_COLOR, KNOT_COLOR, HALO_COLOR, BOUNDARY_COLOR].map((color) => [
      color,
      litColor(color, request.params),
    ]),
  );
  publish(request.channel, {
    state: "ready",
    art: {
      ...message.bitmaps,
      key: request.key,
      spritesOnly: request.spritesOnly,
      light: request.light,
      palette,
      spritesUrl,
      spritesMirroredUrl,
      lightMs: message.lightMs,
    },
  });
}

function start(): Worker | null {
  if (worker !== null) return worker;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    fail("this browser cannot relight the scene in a worker");
    return null;
  }
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    received(event.data);
  });
  worker.addEventListener("error", (event) => {
    fail(event.message || "the relighting worker failed");
  });
  const request: WorkerRequest = {
    type: "init",
    urls: {
      ridgeAlbedo,
      ridgeNormal,
      hillAlbedo,
      hillNormal,
      hillTranslucency,
      spritesAlbedo,
      spritesNormal,
      spritesTranslucency,
      grassAlbedo,
      grassNormal,
      grassTranslucency,
    },
  };
  worker.postMessage(request);
  return worker;
}

/** The art's key: its light, and whether the ridge and hill were lit too. */
const artKey = (light: LightingState, spritesOnly: boolean) =>
  `${lightKey(sceneLight(light))}${spritesOnly ? "|sprites" : ""}`;

function request(
  channel: Channel,
  light: LightingState,
  spritesOnly: boolean,
): void {
  if (snapshots[channel].state === "failed") return;
  const params = sceneLight(light);
  const key = artKey(light, spritesOnly);
  if (key === wanted[channel]) return;
  if (start() === null) return;
  wanted[channel] = key;
  const next = { params, light, spritesOnly };
  if (inFlight[channel]) queued[channel] = next;
  else post(channel, next);
}

function post(channel: Channel, next: Request): void {
  if (worker === null) return;
  inFlight[channel] = true;
  const id = nextId++;
  const { params, spritesOnly } = next;
  pending.set(id, { channel, key: lightKey(params), ...next });
  const message: WorkerRequest = { type: "relight", id, params, spritesOnly };
  worker.postMessage(message);
}

/**
 * What the worker lights for the scene: everything; only the sprites (the
 * GPU tier lights the landscape itself, several times faster); or nothing
 * (the GPU tier lights the plants too).
 */
export type Needs = "all" | "sprites" | "none";

/** The light shown when nothing waits for the worker (`Needs` "none"). */
let direct: LightingState | null = null;

/**
 * Ask for the scene lit for `light`; a no-op when that light is current or
 * pending. With nothing to light in the worker, `light` is shown at once.
 */
export function requestLight(light: LightingState, needs: Needs = "all"): void {
  if (needs === "none") {
    if (direct !== light) {
      direct = light;
      for (const listener of listeners) listener();
    }
    return;
  }
  if (direct !== null) {
    direct = null;
    for (const listener of listeners) listener();
  }
  request("scene", light, needs === "sprites");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest lit art on a channel, re-rendering when it changes. */
export function useSceneArt(channel: Channel = "scene"): SceneArt {
  useEffect(() => {
    // The inspection light never changes: ask for it on first use.
    if (channel === "inspection") request("inspection", DAYTIME, true);
  }, [channel]);
  return useSyncExternalStore(subscribe, () => snapshots[channel]);
}

/**
 * The lighting the scene shows: the state the current art was lit for, so
 * the sky, shadows, and relit art change together, in one frame. Until art
 * is ready (or when it failed), the requested state; when the GPU tier
 * lights everything, the requested state at once.
 */
export function useShownLight(requested: LightingState): LightingState {
  const scene = useSceneArt();
  const shown = useSyncExternalStore(subscribe, () => direct);
  return shown ?? (scene.state === "ready" ? scene.art.light : requested);
}

/**
 * Whether the GPU tier is drawing the hillside's plants now: then nothing
 * else on the hillside needs relit sprites from the worker. Set by the
 * garden canvas (GardenCanvas.tsx), read by the landscape (SceneCanvas.tsx).
 */
let plantsOnGpu = false;

export function setPlantsOnGpu(on: boolean): void {
  if (plantsOnGpu === on) return;
  plantsOnGpu = on;
  for (const listener of listeners) listener();
}

export function usePlantsOnGpu(): boolean {
  return useSyncExternalStore(subscribe, () => plantsOnGpu);
}
