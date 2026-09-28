/**
 * A band worker: holds one band of rows of every scene layer and lights it
 * on request, on its own core. The relighting worker (worker.ts) cuts the
 * layers into bands, sends one to each band worker once, then asks them all
 * to light the same light at once and joins the results.
 */
import { relight, type LayerSource } from "./relight.ts";
import { LAYERS, type LightParams } from "./shading.ts";

export interface BandLayers {
  ridge: LayerSource;
  hill: LayerSource;
  sprites: LayerSource;
  spritesMirrored: LayerSource;
}

export type BandRequest =
  | { type: "init"; layers: BandLayers }
  | { type: "relight"; id: number; params: LightParams; spritesOnly: boolean };

export interface BandResponse {
  id: number;
  ridge: Uint8ClampedArray<ArrayBuffer> | null;
  hill: Uint8ClampedArray<ArrayBuffer> | null;
  sprites: Uint8ClampedArray<ArrayBuffer>;
  spritesMirrored: Uint8ClampedArray<ArrayBuffer>;
}

let layers: BandLayers | null = null;

addEventListener("message", (event: MessageEvent<BandRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    layers = request.layers;
    return;
  }
  if (layers === null) throw new Error("band relight before init");
  const p = request.params;
  const response: BandResponse = {
    id: request.id,
    ridge: request.spritesOnly ? null : relight(layers.ridge, p, LAYERS.ridge),
    hill: request.spritesOnly ? null : relight(layers.hill, p, LAYERS.hill),
    sprites: relight(layers.sprites, p, LAYERS.sprites),
    spritesMirrored: relight(layers.spritesMirrored, p, LAYERS.sprites),
  };
  postMessage(response, {
    transfer: [
      response.ridge,
      response.hill,
      response.sprites,
      response.spritesMirrored,
    ]
      .filter((b) => b !== null)
      .map((b) => b.buffer),
  });
});
