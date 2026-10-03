/**
 * The software tier's relighting worker (ADR 0018, step 3). Decodes the
 * scene art once, then relights every layer on request, off the main
 * thread, and returns ready-to-draw bitmaps. Requests arrive only when the
 * light changes meaningfully (view.ts `lightKey`), about every minute or two
 * while the Sun is up, or continuously while the time slider moves or loops.
 *
 * The texels are lit on every spare core: each layer is cut into bands of
 * rows, one per band worker (band.ts), all lit at once and joined here.
 * Lighting is per texel, so the result matches lighting the layer whole.
 */
import type { BandLayers, BandRequest, BandResponse } from "./band.ts";
import {
  joinBands,
  mirrorCells,
  prepareLayer,
  splitBands,
  type Pixels,
} from "./relight.ts";
import { SPRITE_ATLAS } from "./atlas.ts";
import { GRASS_ATLAS } from "./grass.ts";
import {
  type ArtUrls,
  type LitBitmaps,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";

interface Size {
  width: number;
  height: number;
}

/** What stays here once the layers are handed out: sizes and band rows. */
interface Art {
  size: Record<keyof BandLayers, Size>;
  bands: { worker: Worker; rows: Record<keyof BandLayers, number> }[];
}

/** One band per core, leaving one for the page; at least one, at most 8. */
const BANDS = Math.max(
  1,
  Math.min(8, (globalThis.navigator.hardwareConcurrency || 2) - 1),
);

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
  const [ridge, hill, sprites, grass] = await Promise.all([
    Promise.all([load(urls.ridgeAlbedo), load(urls.ridgeNormal)]).then(
      ([albedo, normals]) => prepareLayer(albedo, normals, null),
    ),
    Promise.all([
      load(urls.hillAlbedo),
      load(urls.hillNormal),
      load(urls.hillTranslucency),
    ]).then(([albedo, normals, translucency]) =>
      prepareLayer(albedo, normals, translucency),
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
    // Tufts are drawn at most about 115 design pixels tall: 256-pixel cells.
    Promise.all([
      load(urls.grassAlbedo, GRASS_ATLAS),
      load(urls.grassNormal, GRASS_ATLAS),
      load(urls.grassTranslucency, GRASS_ATLAS),
    ]).then(([albedo, normals, translucency]) =>
      prepareLayer(albedo, normals, translucency),
    ),
  ]);
  const layers: BandLayers = {
    ridge,
    hill,
    sprites,
    spritesMirrored: mirrorCells(sprites, 2),
    grass,
    grassMirrored: mirrorCells(grass, 2),
  };
  const names = Object.keys(layers) as (keyof BandLayers)[];
  const cut = Object.fromEntries(
    names.map((name) => [name, splitBands(layers[name], BANDS)]),
  ) as Record<keyof BandLayers, ReturnType<typeof splitBands>>;
  const bands = Array.from({ length: BANDS }, (_, i) => {
    const worker = new Worker(new URL("./band.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("error", (event) => {
      reply({
        type: "error",
        message: event.message || "a relighting band worker failed",
      });
    });
    const band = (name: keyof BandLayers) =>
      cut[name][i] as (typeof cut)[keyof BandLayers][number];
    const request: BandRequest = {
      type: "init",
      layers: {
        ridge: band("ridge").source,
        hill: band("hill").source,
        sprites: band("sprites").source,
        spritesMirrored: band("spritesMirrored").source,
        grass: band("grass").source,
        grassMirrored: band("grassMirrored").source,
      },
    };
    // Hand the band over: the whole layers are not kept here.
    worker.postMessage(request, {
      transfer: names.flatMap((name) => {
        const s = band(name).source;
        return [s.albedo.data.buffer, s.normals.data.buffer].concat(
          s.translucency ? [s.translucency.buffer] : [],
        );
      }),
    });
    return {
      worker,
      rows: Object.fromEntries(
        names.map((name) => [name, band(name).row]),
      ) as Record<keyof BandLayers, number>,
    };
  });
  const size = Object.fromEntries(
    names.map((name) => [
      name,
      { width: layers[name].albedo.width, height: layers[name].albedo.height },
    ]),
  ) as Record<keyof BandLayers, Size>;
  return { size, bands };
}

let nextBandId = 1;

/** Light every band at once and join each layer's bands. */
async function lightBands(
  layers: Art,
  params: WorkerRequest & { type: "relight" },
): Promise<Record<keyof BandLayers, Uint8ClampedArray<ArrayBuffer> | null>> {
  const id = nextBandId++;
  const results = await Promise.all(
    layers.bands.map(
      ({ worker }) =>
        new Promise<BandResponse>((resolve) => {
          const listen = (event: MessageEvent<BandResponse>) => {
            if (event.data.id !== id) return;
            worker.removeEventListener("message", listen);
            resolve(event.data);
          };
          worker.addEventListener("message", listen);
          const request: BandRequest = {
            type: "relight",
            id,
            params: params.params,
            spritesOnly: params.spritesOnly,
          };
          worker.postMessage(request);
        }),
    ),
  );
  const join = (name: keyof BandLayers) => {
    const lit = results.map((result, i) => ({
      row: layers.bands[i]?.rows[name] ?? 0,
      rgba: result[name],
    }));
    if (lit.some((band) => band.rgba === null)) return null;
    const { width, height } = layers.size[name];
    return joinBands(
      width,
      height,
      lit as { row: number; rgba: Uint8ClampedArray }[],
    );
  };
  return {
    ridge: join("ridge"),
    hill: join("hill"),
    sprites: join("sprites"),
    spritesMirrored: join("spritesMirrored"),
    grass: join("grass"),
    grassMirrored: join("grassMirrored"),
  };
}

function canvasOf(size: Size, rgba: Uint8ClampedArray<ArrayBuffer>) {
  const { width, height } = size;
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
  const lit = await lightBands(layers, request);
  const lightMs = performance.now() - start;
  const ridge = lit.ridge && canvasOf(layers.size.ridge, lit.ridge);
  const hill = lit.hill && canvasOf(layers.size.hill, lit.hill);
  if (
    lit.sprites === null ||
    lit.spritesMirrored === null ||
    lit.grass === null ||
    lit.grassMirrored === null
  )
    throw new Error("sprite bands missing");
  const sprites = canvasOf(layers.size.sprites, lit.sprites);
  const spritesMirrored = canvasOf(
    layers.size.spritesMirrored,
    lit.spritesMirrored,
  );
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
    grass: canvasOf(layers.size.grass, lit.grass).transferToImageBitmap(),
    grassMirrored: canvasOf(
      layers.size.grassMirrored,
      lit.grassMirrored,
    ).transferToImageBitmap(),
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
      bitmaps.grass,
      bitmaps.grassMirrored,
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
