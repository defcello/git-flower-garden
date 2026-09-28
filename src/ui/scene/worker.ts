/**
 * The software tier's relighting worker (ADR 0018, step 3). Decodes the
 * scene art once, then relights every layer on request, off the main
 * thread, and returns ready-to-draw bitmaps. Requests arrive only when the
 * light changes meaningfully (view.ts `lightKey`), about every minute or two
 * while the Sun is up.
 */
import {
  mirrorCells,
  prepareLayer,
  relight,
  type LayerSource,
  type Pixels,
} from "./relight.ts";
import { LAYERS } from "./shading.ts";
import { SPRITE_ATLAS } from "./atlas.ts";
import {
  type ArtUrls,
  type LitBitmaps,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";

interface Art {
  ridge: LayerSource;
  hill: LayerSource;
  sprites: LayerSource;
  spritesMirrored: LayerSource;
}

async function load(url: string, size?: number): Promise<Pixels> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const width = size ?? bitmap.width;
  const height = size ?? bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context in the worker");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return {
    width,
    height,
    data: context.getImageData(0, 0, width, height).data,
  };
}

async function loadArt(urls: ArtUrls): Promise<Art> {
  const [ridge, hill, sprites] = await Promise.all([
    Promise.all([load(urls.ridgeAlbedo), load(urls.ridgeNormal)]).then(
      ([albedo, normals]) => prepareLayer(albedo, normals, null),
    ),
    Promise.all([
      load(urls.hillAlbedo),
      load(urls.hillNormal),
      load(urls.hillTranslucency),
    ]).then(([albedo, normals, translucency]) =>
      // The Codex hill normal map came back with its X axis inverted.
      prepareLayer(albedo, normals, translucency, { flipX: true }),
    ),
    // Sprites draw at most a few hundred pixels across, even zoomed in on a
    // high-density display: light 256-pixel cells, not the source's 627.
    Promise.all([
      load(urls.spritesAlbedo, SPRITE_ATLAS),
      load(urls.spritesNormal, SPRITE_ATLAS),
      load(urls.spritesTranslucency, SPRITE_ATLAS),
    ]).then(([albedo, normals, translucency]) =>
      prepareLayer(albedo, normals, translucency),
    ),
  ]);
  return { ridge, hill, sprites, spritesMirrored: mirrorCells(sprites, 2) };
}

function canvasOf(source: LayerSource, rgba: Uint8ClampedArray<ArrayBuffer>) {
  const { width, height } = source.albedo;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context in the worker");
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

let art: Promise<Art> | null = null;

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  postMessage(message, { transfer });
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === "init") {
    art = loadArt(request.urls);
    await art;
    return;
  }
  if (art === null) throw new Error("relight before init");
  const layers = await art;
  const start = performance.now();
  const p = request.params;
  const ridge = request.spritesOnly
    ? null
    : canvasOf(layers.ridge, relight(layers.ridge, p, LAYERS.ridge));
  const hill = request.spritesOnly
    ? null
    : canvasOf(layers.hill, relight(layers.hill, p, LAYERS.hill));
  const sprites = canvasOf(
    layers.sprites,
    relight(layers.sprites, p, LAYERS.sprites),
  );
  const spritesMirrored = canvasOf(
    layers.spritesMirrored,
    relight(layers.spritesMirrored, p, LAYERS.sprites),
  );
  const lightMs = performance.now() - start;
  // PNG copies of the atlases for the SVG compositor's <image> elements.
  const [spritesPng, spritesMirroredPng] = await Promise.all([
    sprites.convertToBlob(),
    spritesMirrored.convertToBlob(),
  ]);
  const bitmaps: LitBitmaps = {
    ridge: ridge?.transferToImageBitmap() ?? null,
    hill: hill?.transferToImageBitmap() ?? null,
    sprites: sprites.transferToImageBitmap(),
    spritesMirrored: spritesMirrored.transferToImageBitmap(),
  };
  reply(
    {
      type: "lit",
      id: request.id,
      bitmaps,
      png: { sprites: spritesPng, spritesMirrored: spritesMirroredPng },
      lightMs,
    },
    [
      bitmaps.ridge,
      bitmaps.hill,
      bitmaps.sprites,
      bitmaps.spritesMirrored,
    ].filter((b) => b !== null),
  );
}

// Requests are handled one at a time, in order.
let queue = Promise.resolve();
addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  queue = queue
    .then(() => handle(request))
    .catch((error: unknown) => {
      reply({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
