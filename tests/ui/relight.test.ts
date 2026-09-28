import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { environmentSnapshot } from "../../src/environment/environment.ts";
import { lightingState } from "../../src/environment/lighting.ts";
import { previewSnapshot } from "../../src/environment/overrides.ts";
import {
  mirrorCells,
  joinBands,
  prepareLayer,
  relight,
  splitBands,
  type Pixels,
} from "../../src/ui/scene/relight.ts";
import { LAYERS } from "../../src/ui/scene/shading.ts";
import {
  DAYTIME,
  lightKey,
  litColor,
  plantShadowStyle,
  sceneLight,
} from "../../src/ui/scene/view.ts";

const noon = lightingState(previewSnapshot("noon"));
const sunrise = lightingState(previewSnapshot("sunrise"));
const sunset = lightingState(previewSnapshot("sunset"));
const night = lightingState(previewSnapshot("night"));

/** A width×1 image from per-texel RGBA tuples. */
function image(texels: number[][]): Pixels {
  return {
    width: texels.length,
    height: 1,
    data: Uint8ClampedArray.from(texels.flat()),
  };
}

/** A normal encoded as RGB, alpha 255. */
const normal = (x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z);
  return [
    (x / l) * 127.5 + 127.5,
    (y / l) * 127.5 + 127.5,
    (z / l) * 127.5 + 127.5,
    255,
  ];
};

const luminance = (rgba: Uint8ClampedArray, texel: number) =>
  (rgba[texel * 4] ?? 0) +
  (rgba[texel * 4 + 1] ?? 0) +
  (rgba[texel * 4 + 2] ?? 0);

const GREEN = [90, 150, 70, 255];

describe("preparing a layer", () => {
  it("snaps noisy keyed alpha at both ends", () => {
    const layer = prepareLayer(
      image([
        [0, 255, 0, 3],
        [90, 150, 70, 120],
        [90, 150, 70, 250],
      ]),
      image([normal(0, 0, 1), normal(0, 0, 1), normal(0, 0, 1)]),
      null,
    );
    expect([...layer.albedo.data].filter((_, i) => i % 4 === 3)).toEqual([
      0, 120, 255,
    ]);
  });

  it("renormalizes normals, faces the viewer outside the silhouette, and applies flipX", () => {
    const layer = prepareLayer(
      image([GREEN, [0, 0, 0, 0]]),
      // An unnormalized normal pointing right, and junk outside.
      image([
        [255, 128, 200, 255],
        [10, 20, 30, 255],
      ]),
      null,
      { flipX: true },
    );
    const n = layer.normals.data;
    const decode = (i: number) => (n[i] ?? 0) / 127.5 - 1;
    const [x, y, z] = [decode(0), decode(1), decode(2)];
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
    expect(x).toBeLessThan(-0.5); // flipped to point left
    expect([n[4], n[5], n[6], n[7]]).toEqual([128, 128, 255, 0]);
  });

  it("reads translucency as luminance, and none outside the silhouette", () => {
    const layer = prepareLayer(
      image([GREEN, [0, 0, 0, 0]]),
      image([normal(0, 0, 1), normal(0, 0, 1)]),
      image([
        [255, 255, 255, 255],
        [255, 255, 255, 255],
      ]),
    );
    expect([...(layer.translucency ?? [])]).toEqual([255, 0]);
  });

  it("refuses maps that do not match the albedo's size", () => {
    expect(() =>
      prepareLayer(image([GREEN, GREEN]), image([normal(0, 0, 1)]), null),
    ).toThrow(/map is 1×1/);
  });
});

describe("relighting", () => {
  const params = sceneLight(noon);

  it("is brighter facing the Sun than facing away, and keeps alpha", () => {
    const sun = noon.sun.direction;
    const layer = prepareLayer(
      image([GREEN, GREEN, [0, 0, 0, 0]]),
      image([
        normal(sun.x, sun.y, Math.max(0.2, sun.z)),
        normal(-sun.x, -0.5, 0.2),
        normal(0, 0, 1),
      ]),
      null,
    );
    const lit = relight(layer, params, LAYERS.hill);
    expect(luminance(lit, 0)).toBeGreaterThan(luminance(lit, 1));
    expect(lit[3]).toBe(255);
    expect([...lit.slice(8)]).toEqual([0, 0, 0, 0]);
  });

  it("lets light through where the translucency map is white", () => {
    // Backlit: the evening Sun is behind the scene, the texel faces away.
    const params = sceneLight(sunset);
    const sun = sunset.sun.direction;
    const away = normal(-sun.x, -sun.y, -sun.z);
    const opaque = prepareLayer(
      image([GREEN]),
      image([away]),
      image([[0, 0, 0, 255]]),
    );
    const thin = prepareLayer(
      image([GREEN]),
      image([away]),
      image([[255, 255, 255, 255]]),
    );
    expect(luminance(relight(thin, params, LAYERS.sprites), 0)).toBeGreaterThan(
      luminance(relight(opaque, params, LAYERS.sprites), 0),
    );
  });

  it("darkens at night and is deterministic", () => {
    const layer = prepareLayer(
      image([GREEN]),
      image([normal(0, 0.3, 1)]),
      null,
    );
    const day = relight(layer, params, LAYERS.hill);
    const dark = relight(layer, sceneLight(night), LAYERS.hill);
    expect(luminance(dark, 0)).toBeLessThan(luminance(day, 0) / 3);
    expect(relight(layer, params, LAYERS.hill)).toEqual(day);
  });

  it("lights a mirrored cell as a mirror image with its light from the other side", () => {
    // Two cells of two texels: each cell reverses, and normals' x flips.
    const layer = prepareLayer(
      image([
        [10, 20, 30, 255],
        [40, 50, 60, 255],
        [70, 80, 90, 255],
        [100, 110, 120, 0],
      ]),
      image([
        normal(1, 0, 1),
        normal(0, 1, 1),
        normal(-1, 0, 1),
        normal(0, 0, 1),
      ]),
      image([
        [10, 10, 10, 255],
        [20, 20, 20, 255],
        [30, 30, 30, 255],
        [40, 40, 40, 255],
      ]),
    );
    const mirrored = mirrorCells(layer, 2);
    const texel = (p: Pixels, t: number) => [...p.data.slice(t * 4, t * 4 + 4)];
    expect(texel(mirrored.albedo, 0)).toEqual(texel(layer.albedo, 1));
    expect(texel(mirrored.albedo, 1)).toEqual(texel(layer.albedo, 0));
    expect(texel(mirrored.albedo, 2)).toEqual(texel(layer.albedo, 3));
    expect(mirrored.normals.data[4]).toBe(255 - (layer.normals.data[0] ?? 0));
    expect([...(mirrored.translucency ?? [])]).toEqual([20, 10, 0, 30]);
    // Mirroring twice restores the layer.
    const twice = mirrorCells(mirrored, 2);
    expect(twice.albedo.data).toEqual(layer.albedo.data);
    expect(twice.normals.data).toEqual(layer.normals.data);
    expect(() => mirrorCells(layer, 3)).toThrow(/cells/);
  });
});

describe("lighting in bands on several cores", () => {
  it("matches the layer lit whole, byte for byte, for any number of bands", () => {
    let seed = 11;
    const byte = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed >>> 24;
    };
    const width = 13;
    const height = 7;
    const pixels = (alpha: boolean): Pixels => ({
      width,
      height,
      data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) =>
        i % 4 === 3 && !alpha ? 255 : byte(),
      ),
    });
    const layer = prepareLayer(pixels(true), pixels(false), pixels(false));
    const params = sceneLight(sunset);
    const whole = relight(layer, params, LAYERS.hill);
    for (const parts of [1, 2, 3, 4, 7]) {
      const bands = splitBands(layer, parts);
      expect(bands.reduce((rows, b) => rows + b.source.albedo.height, 0)).toBe(
        height,
      );
      // Reversed: the order bands come back in does not matter.
      const lit = bands
        .map((band) => ({
          row: band.row,
          rgba: relight(band.source, params, LAYERS.hill),
        }))
        .reverse();
      expect(joinBands(width, height, lit)).toEqual(whole);
    }
  });
});

describe("when to relight", () => {
  const at = (iso: string) =>
    sceneLight(
      lightingState(
        environmentSnapshot(
          new Date(iso),
          { latitude: 35.6, longitude: -82.55, elevationMeters: 650 },
          "America/New_York",
        ),
      ),
    );

  it("ignores a few seconds but not a few minutes of the Sun's motion", () => {
    expect(lightKey(at("2024-06-20T16:00:00Z"))).toBe(
      lightKey(at("2024-06-20T16:00:05Z")),
    );
    expect(lightKey(at("2024-06-20T16:00:00Z"))).not.toBe(
      lightKey(at("2024-06-20T16:05:00Z")),
    );
  });

  it("ignores where a dark Moon is", () => {
    // New moon, below the horizon: its direction lights nothing.
    const a = at("2024-06-06T16:00:00Z");
    const b = { ...a, moonDir: { x: -a.moonDir.x, y: a.moonDir.y, z: 0.5 } };
    expect(Math.max(...a.moon)).toBeLessThan(0.0025);
    expect(lightKey(b)).toBe(lightKey(a));
  });
});

describe("lit plant colors and shadows", () => {
  const brightness = (css: string) =>
    (css.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);

  it("stems darken with the scene", () => {
    const day = litColor("#456b39", sceneLight(noon));
    const dark = litColor("#456b39", sceneLight(night));
    expect(day).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    expect(brightness(dark)).toBeLessThan(brightness(day) / 3);
  });

  it("the daylight fallback is the noon preview", () => {
    expect(DAYTIME).toEqual(noon);
  });

  it("plants cast away from the Sun, and not at all at night", () => {
    const x = (state: typeof noon) =>
      parseFloat(plantShadowStyle(state)["--shadow-x"] ?? "");
    // Morning Sun in the east (screen left): shadows fall to the right.
    expect(x(sunrise)).toBeGreaterThan(0);
    expect(x(sunset)).toBeLessThan(0);
    expect(plantShadowStyle(night)["--shadow-alpha"]).toBe("0");
  });
});

describe("scene art", () => {
  it("ships exactly the files, sizes, and checksums in the asset manifest", () => {
    const manifest = JSON.parse(
      readFileSync("src/ui/public/asset-manifest.json", "utf8"),
    ) as {
      assets: {
        file: string;
        sha256: string;
        dimensions: { width: number; height: number };
      }[];
    };
    expect(manifest.assets).toHaveLength(8);
    for (const asset of manifest.assets) {
      const bytes = readFileSync(`src/ui/assets/${asset.file}`);
      expect(createHash("sha256").update(bytes).digest("hex"), asset.file).toBe(
        asset.sha256,
      );
      expect(
        [bytes.readUInt32BE(16), bytes.readUInt32BE(20)],
        asset.file,
      ).toEqual([asset.dimensions.width, asset.dimensions.height]);
    }
  });
});
