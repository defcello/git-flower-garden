/** Messages between the scene client and its relighting worker. */
import type { LightParams } from "./shading.ts";

export interface ArtUrls {
  ridgeAlbedo: string;
  ridgeNormal: string;
  hillAlbedo: string;
  hillNormal: string;
  hillTranslucency: string;
  spritesAlbedo: string;
  spritesNormal: string;
  spritesTranslucency: string;
}

export type WorkerRequest =
  | { type: "init"; urls: ArtUrls }
  | {
      type: "relight";
      id: number;
      params: LightParams;
      /** Light only the sprite atlases; ridge and hill come back null. */
      spritesOnly: boolean;
    };

export interface LitBitmaps {
  ridge: ImageBitmap | null;
  hill: ImageBitmap | null;
  sprites: ImageBitmap;
  /** Each cell mirrored left to right and lit as such. */
  spritesMirrored: ImageBitmap;
}

export type WorkerResponse =
  | {
      type: "lit";
      id: number;
      bitmaps: LitBitmaps;
      png: { sprites: Blob; spritesMirrored: Blob };
      /** Time spent lighting texels, excluding encoding. */
      lightMs: number;
    }
  | { type: "error"; message: string };
