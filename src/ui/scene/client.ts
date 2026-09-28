/**
 * The page's one relighting worker and the latest lit art (ADR 0018, step
 * 3), on two channels:
 *
 * - "scene": the whole landscape and the hillside plants, lit by the
 *   current sky;
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
import {
  BOUNDARY_COLOR,
  HALO_COLOR,
  KNOT_COLOR,
  STEM_COLOR,
} from "../botanical.ts";
import type { LitBitmaps, WorkerRequest, WorkerResponse } from "./protocol.ts";
import type { LightParams } from "./shading.ts";
import { DAYTIME, lightKey, litColor, sceneLight } from "./view.ts";

export type Channel = "scene" | "inspection";

export interface LitArt extends LitBitmaps {
  /** The light it was lit with (view.ts `lightKey`). */
  key: string;
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
const pending = new Map<
  number,
  { channel: Channel; key: string; params: LightParams }
>();
/**
 * One relight in flight per channel; while it runs, only the newest light
 * asked for waits. Dragging the time of day never queues a backlog of
 * relights: the scene catches up with the slider, one relight behind.
 */
const inFlight: Record<Channel, boolean> = { scene: false, inspection: false };
const queued: Record<Channel, LightParams | null> = {
  scene: null,
  inspection: null,
};

function closeAll(b: LitBitmaps) {
  for (const bitmap of [b.ridge, b.hill, b.sprites, b.spritesMirrored])
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
    (current.state === "ready" && current.art.key === wanted[request.channel])
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
    },
  };
  worker.postMessage(request);
  return worker;
}

function request(channel: Channel, params: LightParams): void {
  if (snapshots[channel].state === "failed") return;
  const key = lightKey(params);
  if (key === wanted[channel]) return;
  if (start() === null) return;
  wanted[channel] = key;
  if (inFlight[channel]) queued[channel] = params;
  else post(channel, params);
}

function post(channel: Channel, params: LightParams): void {
  if (worker === null) return;
  inFlight[channel] = true;
  const id = nextId++;
  pending.set(id, { channel, key: lightKey(params), params });
  const message: WorkerRequest = {
    type: "relight",
    id,
    params,
    spritesOnly: channel === "inspection",
  };
  worker.postMessage(message);
}

/** Ask for the scene lit by `params`; a no-op when that light is current or pending. */
export function requestLight(params: LightParams): void {
  request("scene", params);
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
    if (channel === "inspection") request("inspection", sceneLight(DAYTIME));
  }, [channel]);
  return useSyncExternalStore(subscribe, () => snapshots[channel]);
}
