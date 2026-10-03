/**
 * The GPU tier's plants (ADR 0018, step 4): every hillside plant of the
 * SceneDescription, back to front, drawn with WebGL2 and lit every frame
 * by the same `SHADE_GLSL` as the landscape, so the plants follow the
 * light at once and the worker has nothing to relight.
 *
 * Per plant, in the software tier's order (GardenCanvas.tsx):
 *
 * - its shadow, or its cyan outline when highlighted: a blurred
 *   silhouette, made once per plant and size with Canvas 2D; the Sun
 *   lays it on the ground (view.ts castOnGround) and fades it with
 *   uniforms, so the light never rebuilds it;
 * - ground shadows, as ellipses;
 * - stems and knots: drawn unlit with Canvas 2D into a texture, rebuilt
 *   only while the plant grows, and lit in the shader with the stems'
 *   one light (`stemLight`, what `litColor` applies);
 * - sprites, instanced from the full-resolution albedo, normal, and
 *   translucency maps; a mirrored sprite samples its cell mirrored with
 *   its normals' x negated, as `mirrorCells` does. Sway comes from
 *   sway.ts, as in Software;
 * - hidden-commit badges, unlit, in the panels' colors.
 *
 * Between the plants, the grass (grass.ts): instanced tufts, each leaning
 * by a shear about its base, lit like the sprites from the grass maps; a
 * plant stands in front of the tufts that grow behind its base.
 *
 * Wilting is the CSS filter's color matrix, applied in the shader.
 */
import type { LightingState } from "../../environment/lighting.ts";
import { CELL_SIZE, type Sprite } from "../botanical.ts";
import {
  canvasFilters,
  castShadows,
  GROUND_COLOR,
  GROUND_RY,
  MARGIN,
  OUTLINE,
  paintBadges,
  paintGrounds,
  paintSprites,
  paintStems,
  PathCache,
  type BadgeStyle,
  type PaintArt,
} from "../paint.ts";
import {
  currentWind,
  MAX_WIND_STRENGTH,
  swayStrength,
  swaySprites,
  swayWind,
} from "../sway.ts";
import { gpuSupport, preset } from "../motion.ts";
import {
  grassField,
  TUFT_BASE,
  TUFT_RECT,
  SHEEN,
  tuftPose,
  tuftSquash,
  type Tuft,
} from "./grass.ts";
import { settledFrame, type Frame } from "../transition.ts";
import { groundLine, toDesign, type PlantDescription } from "./description.ts";
import type { SceneDescription } from "./description.ts";
import {
  compile,
  CONTEXT,
  LIGHT_UNIFORMS,
  loadMaps,
  rendererName,
  setLight,
  SHADE_GLSL,
  TO_CLIP_GLSL,
  uniforms,
  uploadCanvas,
  uploadMap,
  type Uniforms,
} from "./gl.ts";
import { LAYERS } from "./shading.ts";
import type { GpuRenderer } from "./useGpu.ts";
import {
  DESIGN,
  plantShadow,
  PLANT_SHADOW_BLUR,
  PLANT_SHADOW_RGB,
  sceneLight,
  stemLight,
  type PlantShadow,
} from "./view.ts";

/** CSS saturate(0.45) then brightness(0.92) (paint.ts WILTING), in GLSL. */
const WILT_GLSL = `
uniform bool uWilting;
vec4 wilt(vec4 c) {
  if (!uWilting) return c;
  const float s = 0.45;
  mat3 saturate = mat3(
    0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
    0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
    0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
  return vec4(clamp(saturate * c.rgb, 0.0, c.a) * 0.92, c.a);
}
`;

/**
 * A textured rectangle in canvas pixels, upright, or laid on the ground as
 * a shadow (view.ts castOnGround) when `uGround`'s squash is not 0.
 */
const QUAD_VS = `#version 300 es
uniform vec4 uRect;
uniform vec3 uGround; // shear, squash, base y
uniform vec2 uResolution;
out vec2 vUv;
${TO_CLIP_GLSL}
void main() {
  vec2 uv = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0,
                 gl_VertexID >= 2 ? 1.0 : 0.0);
  vUv = uv;
  vec2 p = uRect.xy + uv * uRect.zw;
  if (uGround.y != 0.0) {
    float h = uGround.z - p.y;
    p = vec2(p.x + uGround.x * h, uGround.z + uGround.y * h);
  }
  gl_Position = toClip(p, uResolution);
}`;

/**
 * A plant's texture: 0 as is (badges, outline); 1 lit as stems (unlit
 * colors times `uLight`); 2 a shadow (its alpha, in `uColor`).
 */
const QUAD_FS = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform int uMode;
uniform vec3 uLight;
uniform vec4 uColor;
in vec2 vUv;
out vec4 color;
${WILT_GLSL}
void main() {
  vec4 a = texture(uTexture, vUv);
  if (a.a <= 0.0) discard;
  if (uMode == 2) {
    color = uColor * a.a;
    return;
  }
  if (uMode == 1) {
    vec3 lit = pow(a.rgb / a.a, vec3(2.2)) * uLight;
    a.rgb = pow(clamp(lit, 0.0, 1.0), vec3(1.0 / 2.2)) * a.a;
  }
  color = wilt(a);
}`;

/** Placement of a plant's graph coordinates: canvas = graph * k + offset. */
const PLACE_GLSL = `
uniform vec3 uPlace; // k, offset x, offset y
uniform vec2 uResolution;
${TO_CLIP_GLSL}
vec4 place(vec2 graph) {
  return toClip(graph * uPlace.x + uPlace.yz, uResolution);
}
`;

const GROUND_VS = `#version 300 es
in vec3 aGround; // x, y, radius x (graph pixels)
out vec2 vLocal; // in radii: the ellipse is the unit circle
out vec2 vPixels; // radii in canvas pixels
${PLACE_GLSL}
const float RY = ${GROUND_RY.toFixed(1)};
void main() {
  vec2 corner = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : -1.0,
                     gl_VertexID >= 2 ? 1.0 : -1.0);
  vec2 radii = vec2(aGround.z, RY);
  // One canvas pixel of room for the soft edge.
  vec2 grow = 1.0 + 1.0 / max(radii * uPlace.x, vec2(0.5));
  vLocal = corner * grow;
  vPixels = radii * uPlace.x;
  gl_Position = place(aGround.xy + corner * grow * radii);
}`;

const GROUND_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
in vec2 vLocal;
in vec2 vPixels;
out vec4 color;
${WILT_GLSL}
void main() {
  float d = length(vLocal);
  // Distance to the edge in canvas pixels, roughly, for a one-pixel ramp.
  float edge = (1.0 - d) * min(vPixels.x, vPixels.y);
  float a = clamp(edge + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  color = wilt(uColor * a);
}`;

const SPRITE_VS = `#version 300 es
in vec4 aSprite; // x, y, drawn size, rotation (graph pixels, radians)
in vec3 aCell;   // kind, mirrored, alpha
out vec2 vUv;
flat out int vFlip;
out float vAlpha;
${PLACE_GLSL}
void main() {
  vec2 local = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0,
                    gl_VertexID >= 2 ? 1.0 : 0.0);
  vec2 p = (local - 0.5) * aSprite.z;
  float c = cos(aSprite.w);
  float s = sin(aSprite.w);
  // As Canvas rotates, with y down.
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + aSprite.xy;
  float kind = aCell.x;
  vec2 cell = vec2(mod(kind, 2.0), floor(kind / 2.0)) * 0.5;
  vFlip = aCell.y > 0.5 ? 1 : 0;
  vUv = cell + vec2(vFlip == 1 ? 1.0 - local.x : local.x, local.y) * 0.5;
  vAlpha = aCell.z;
  gl_Position = place(p);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uTranslucency;
uniform float uLayerFill, uLayerHaze;
in vec2 vUv;
flat in int vFlip;
in float vAlpha;
out vec4 color;
${SHADE_GLSL}
${WILT_GLSL}
// Sprites are drawn far smaller than their maps: trilinear filtering alone
// is softer than Canvas's high-quality downscale, so sample a little sharper.
const float BIAS = -0.75;
void main() {
  vec4 lit = shadeTexel(texture(uAlbedo, vUv, BIAS),
                        texture(uNormal, vUv, BIAS).rgb, vFlip == 1,
                        luminance(texture(uTranslucency, vUv, BIAS).rgb),
                        uLayerFill, uLayerHaze, ${LAYERS.sprites.night.toFixed(1)});
  if (lit.a <= 0.0) discard;
  color = wilt(lit * vAlpha);
}`;

/** Floats per sprite instance: aSprite (4) and aCell (3). */
const SPRITE_FLOATS = 7;

/** SPRITE_FS for the grass, with the sheen of the passing waves (grass.ts SHEEN). */
const GRASS_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uTranslucency;
uniform float uLayerFill, uLayerHaze, uDaylight;
in vec2 vUv;
flat in int vFlip;
in float vAlpha;
in float vLift;
out vec4 color;
${SHADE_GLSL}
const float BIAS = -0.75;
void main() {
  vec4 lit = shadeTexel(texture(uAlbedo, vUv, BIAS),
                        texture(uNormal, vUv, BIAS).rgb, vFlip == 1,
                        luminance(texture(uTranslucency, vUv, BIAS).rgb),
                        uLayerFill, uLayerHaze, ${LAYERS.grass.night.toFixed(1)});
  if (lit.a <= 0.0) discard;
  float up = max(vLift, 0.0) * ${SHEEN.lift.toFixed(3)} * uDaylight;
  lit.rgb = mix(lit.rgb, vec3(${SHEEN.color.map((c) => c.toFixed(3)).join(", ")}) * lit.a, up);
  lit.rgb *= 1.0 - max(-vLift, 0.0) * ${SHEEN.shade.toFixed(3)};
  color = lit;
}`;

/**
 * A grass tuft growing from its base, leaning by a shear about it (the
 * tip moves `lean` heights downwind) and shortened by `squash`, as
 * GardenCanvas.tsx paintTuft draws it, with its sheen. Lit by GRASS_FS.
 */
const GRASS_VS = `#version 300 es
in vec4 aTuft;  // base x, y (design pixels), size, lean
in vec4 aCell;  // kind, mirrored, squash, lift
uniform vec2 uResolution;
uniform float uScale; // canvas pixels per design pixel
uniform vec2 uBase[4];
uniform vec4 uRect[4]; // what each tuft covers of its cell (grass.ts)
out vec2 vUv;
flat out int vFlip;
out float vAlpha;
out float vLift;
${TO_CLIP_GLSL}
void main() {
  vec2 local = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0,
                    gl_VertexID >= 2 ? 1.0 : 0.0);
  vFlip = aCell.y > 0.5 ? 1 : 0;
  vLift = aCell.w;
  int kind = int(aCell.x + 0.5);
  vec2 base = uBase[kind];
  vec4 rect = uRect[kind];
  // Only the tuft's own rectangle of its cell, in cell fractions.
  local = mix(rect.xy, rect.zw, local);
  // A mirrored tuft is placed mirrored and samples its cell as it is (the
  // shader negates its normals' x).
  if (vFlip == 1) base.x = 1.0 - base.x;
  vec2 drawn = vec2(vFlip == 1 ? 1.0 - local.x : local.x, local.y);
  vec2 p = (drawn - base) * aTuft.z;
  p = vec2(p.x - aTuft.w * p.y, p.y * aCell.z);
  vec2 cell = vec2(mod(aCell.x, 2.0), floor(aCell.x / 2.0)) * 0.5;
  vUv = cell + local * 0.5;
  vAlpha = 1.0;
  gl_Position = toClip((aTuft.xy + p) * uScale, uResolution);
}`;

/** Floats per tuft instance: aTuft (4) and aCell (4). */
const GRASS_FLOATS = 8;
/** The grass maps' texture units: clear of the sprites' (0–3) and uploads (7). */
const GRASS_UNIT = 4;

/** Parse an `rgba(r, g, b, a)` color into premultiplied 0..1 values. */
function premultiplied(css: string): [number, number, number, number] {
  const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
  return [(r / 255) * a, (g / 255) * a, (b / 255) * a, a];
}

const GROUND = premultiplied(GROUND_COLOR);
const SHADOW_RGB = PLANT_SHADOW_RGB.split(" ").map((v) => Number(v) / 255);

/** A plant's textures and where they go, in canvas pixels. */
interface Entry {
  key: string;
  scene: PlantDescription["scene"];
  left: number;
  top: number;
  width: number;
  height: number;
  /** Unlit stems and knots, and the frame they show. */
  stems: WebGLTexture | null;
  stemsFrame: Frame | null;
  badges: WebGLTexture | null | undefined;
  /** The blurred silhouette at rest (black), for the drop shadow. */
  shadow: WebGLTexture | null | undefined;
  /** The cyan outline under a highlighted plant. */
  outline: WebGLTexture | null | undefined;
}

export class PlantsGpu implements GpuRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #quad: WebGLProgram;
  readonly #ground: WebGLProgram;
  readonly #sprite: WebGLProgram;
  readonly #grass: WebGLProgram;
  readonly #grassU: Uniforms;
  readonly #grassVao: WebGLVertexArrayObject;
  readonly #grassBuffer: WebGLBuffer;
  readonly #grassAttribs: { tuft: number; cell: number };
  readonly #quadU: Uniforms;
  readonly #groundU: Uniforms;
  readonly #spriteU: Uniforms;
  readonly #empty: WebGLVertexArrayObject;
  readonly #groundVao: WebGLVertexArrayObject;
  readonly #groundBuffer: WebGLBuffer;
  readonly #spriteVao: WebGLVertexArrayObject;
  readonly #spriteBuffer: WebGLBuffer;
  #maps: {
    albedo: WebGLTexture;
    normal: WebGLTexture;
    translucency: WebGLTexture;
    grass: [WebGLTexture, WebGLTexture, WebGLTexture];
  } | null = null;
  /** Unlit atlases at the Canvas painters' cell size, for silhouettes. */
  #silhouetteArt: PaintArt | null = null;
  readonly #entries = new Map<string, Entry>();
  readonly #paths = new PathCache();
  readonly #scratch = document.createElement("canvas");
  readonly #out = document.createElement("canvas");
  readonly renderer: string;

  /** Null without WebGL2. The caller decided whether software WebGL is acceptable. */
  static readonly create = (canvas: HTMLCanvasElement): PlantsGpu | null => {
    const gl = canvas.getContext("webgl2", CONTEXT);
    return gl === null || gl.isContextLost() ? null : new PlantsGpu(gl);
  };

  private constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#quad = compile(gl, QUAD_VS, QUAD_FS);
    this.#ground = compile(gl, GROUND_VS, GROUND_FS);
    this.#sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.#grass = compile(gl, GRASS_VS, GRASS_FS);
    this.#grassU = uniforms(gl, this.#grass, [
      "uResolution",
      "uScale",
      "uBase",
      "uRect",
      "uAlbedo",
      "uNormal",
      "uTranslucency",
      "uLayerFill",
      "uLayerHaze",
      "uDaylight",
      ...LIGHT_UNIFORMS,
    ]);
    this.#quadU = uniforms(gl, this.#quad, [
      "uRect",
      "uGround",
      "uResolution",
      "uTexture",
      "uMode",
      "uLight",
      "uColor",
      "uWilting",
    ]);
    this.#groundU = uniforms(gl, this.#ground, [
      "uPlace",
      "uResolution",
      "uColor",
      "uWilting",
    ]);
    this.#spriteU = uniforms(gl, this.#sprite, [
      "uPlace",
      "uResolution",
      "uAlbedo",
      "uNormal",
      "uTranslucency",
      "uLayerFill",
      "uLayerHaze",
      "uWilting",
      ...LIGHT_UNIFORMS,
    ]);
    this.#empty = gl.createVertexArray();

    this.#groundBuffer = gl.createBuffer();
    this.#groundVao = gl.createVertexArray();
    gl.bindVertexArray(this.#groundVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#groundBuffer);
    const ground = gl.getAttribLocation(this.#ground, "aGround");
    gl.enableVertexAttribArray(ground);
    gl.vertexAttribPointer(ground, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(ground, 1);

    this.#spriteBuffer = gl.createBuffer();
    this.#spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.#spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#spriteBuffer);
    const stride = SPRITE_FLOATS * 4;
    const sprite = gl.getAttribLocation(this.#sprite, "aSprite");
    gl.enableVertexAttribArray(sprite);
    gl.vertexAttribPointer(sprite, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(sprite, 1);
    const cell = gl.getAttribLocation(this.#sprite, "aCell");
    gl.enableVertexAttribArray(cell);
    gl.vertexAttribPointer(cell, 3, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(cell, 1);

    this.#grassBuffer = gl.createBuffer();
    this.#grassVao = gl.createVertexArray();
    gl.bindVertexArray(this.#grassVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#grassBuffer);
    this.#grassAttribs = {
      tuft: gl.getAttribLocation(this.#grass, "aTuft"),
      cell: gl.getAttribLocation(this.#grass, "aCell"),
    };
    for (const location of Object.values(this.#grassAttribs)) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.renderer = rendererName(gl);
  }

  async load(): Promise<void> {
    const { sprites, grass } = await loadMaps();
    const art = await silhouetteArt(sprites.albedo);
    const gl = this.#gl;
    if (
      gl.isContextLost() ||
      sprites.translucency === null ||
      grass.translucency === null
    )
      return;
    this.#maps = {
      albedo: uploadMap(gl, sprites.albedo),
      normal: uploadMap(gl, sprites.normal),
      translucency: uploadMap(gl, sprites.translucency),
      grass: [
        uploadMap(gl, grass.albedo),
        uploadMap(gl, grass.normal),
        uploadMap(gl, grass.translucency),
      ],
    };
    this.#silhouetteArt = art;
  }

  /**
   * Wait until the GPU has finished what was drawn, for the frame-time
   * probe: reading one pixel back cannot happen sooner.
   */
  finish(): void {
    this.#gl.readPixels(
      0,
      0,
      1,
      1,
      this.#gl.RGBA,
      this.#gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
  }

  dispose(): void {
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Whether the sprite maps are uploaded, so plants can be drawn. */
  get ready(): boolean {
    return this.#maps !== null;
  }

  /**
   * Draw every plant of `description` lit by `state`, at `seconds` on the
   * sway clock (null: at rest). Returns false until the maps are loaded.
   */
  paint(
    description: SceneDescription,
    state: LightingState,
    badges: BadgeStyle,
    frameOf: (plant: PlantDescription) => Frame,
    seconds: number | null,
  ): boolean {
    const gl = this.#gl;
    const maps = this.#maps;
    const art = this.#silhouetteArt;
    if (gl.isContextLost() || maps === null || art === null) return false;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width;
    const H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const p = sceneLight(state);
    const stems = stemLight(p);
    const shadow = plantShadow(state);
    // The canvas is the 16:9 stage, so design pixels scale uniformly.
    const t = W / DESIGN.width;
    const size = `${String(W)}x${String(H)}`;
    const badgeKey = Object.values(badges).join("|");

    // Light every program's uniforms once per frame.
    gl.useProgram(this.#sprite);
    const su = this.#spriteU;
    setLight(gl, su, p);
    gl.uniform2f(su.uResolution ?? null, W, H);
    gl.uniform1i(su.uAlbedo ?? null, 0);
    gl.uniform1i(su.uNormal ?? null, 1);
    gl.uniform1i(su.uTranslucency ?? null, 2);
    // Sprites take the fill light (LAYERS.sprites.fill).
    gl.uniform1f(su.uLayerFill ?? null, 1);
    gl.uniform1f(su.uLayerHaze ?? null, LAYERS.sprites.haze);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maps.albedo);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maps.normal);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, maps.translucency);
    gl.useProgram(this.#grass);
    const gu = this.#grassU;
    setLight(gl, gu, p);
    gl.uniform2f(gu.uResolution ?? null, W, H);
    gl.uniform1f(gu.uScale ?? null, t);
    gl.uniform2fv(
      gu.uBase ?? null,
      TUFT_BASE.flatMap((b) => [b.x, b.y]),
    );
    gl.uniform4fv(gu.uRect ?? null, TUFT_RECT.flat());
    gl.uniform1i(gu.uAlbedo ?? null, GRASS_UNIT);
    gl.uniform1i(gu.uNormal ?? null, GRASS_UNIT + 1);
    gl.uniform1i(gu.uTranslucency ?? null, GRASS_UNIT + 2);
    gl.uniform1f(gu.uLayerFill ?? null, 1);
    gl.uniform1f(gu.uLayerHaze ?? null, LAYERS.grass.haze);
    gl.uniform1f(gu.uDaylight ?? null, Math.min(1, state.sun.intensity));
    maps.grass.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE0 + GRASS_UNIT + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
    // The grass, back to front, between the plants: each plant stands in
    // front of the tufts that grow behind its base.
    // Software WebGL (only by hand: Auto refuses it) fills on the CPU too,
    // so it plants Software's grass.
    const tufts = grassField(
      gpuSupport() === "hardware"
        ? preset().grass.gpu
        : preset().grass.software,
    );
    this.#uploadGrass(tufts, seconds);
    let next = 0;
    const grassTo = (y: number) => {
      let end = next;
      while (end < tufts.length && (tufts[end]?.y ?? Infinity) <= y) end++;
      this.#grassBatch(next, end);
      next = end;
    };
    gl.useProgram(this.#ground);
    gl.uniform2f(this.#groundU.uResolution ?? null, W, H);
    gl.uniform4fv(this.#groundU.uColor ?? null, GROUND);
    gl.useProgram(this.#quad);
    gl.uniform2f(this.#quadU.uResolution ?? null, W, H);
    gl.uniform1i(this.#quadU.uTexture ?? null, 3);
    gl.uniform3fv(this.#quadU.uLight ?? null, stems);

    const seen = new Set<string>();
    for (const plant of description.plants) {
      seen.add(plant.id);
      grassTo(plant.highlighted ? Infinity : plant.y);
      const corner = toDesign(plant, plant.bounds.x, plant.bounds.y);
      const k = plant.scale * t;
      const at = { k, x: corner.x * t, y: corner.y * t };
      const entry = this.#entry(plant, at, `${size}|${badgeKey}`);
      if (
        entry.left + entry.width + MARGIN * k < 0 ||
        entry.top + entry.height + MARGIN * k < 0 ||
        entry.left - MARGIN * k > W ||
        entry.top - MARGIN * k > H
      )
        continue;
      const frame = frameOf(plant);
      const still = seconds === null || plant.highlighted || plant.wilting;
      const place: [number, number, number] = [
        k,
        at.x - plant.bounds.x * k,
        at.y - plant.bounds.y * k,
      ];

      // Under the plant: its outline, or its shadow.
      if (plant.highlighted) {
        entry.outline ??= this.#outline(plant, at, entry, art, badges);
        this.#texture(entry.outline, entry, 0);
      } else if (shadow !== null && shadow.alpha > 0) {
        entry.shadow ??= this.#shadow(plant, at, entry, art, badges);
        gl.useProgram(this.#quad);
        gl.uniform4f(
          this.#quadU.uColor ?? null,
          (SHADOW_RGB[0] ?? 0) * shadow.alpha,
          (SHADOW_RGB[1] ?? 0) * shadow.alpha,
          (SHADOW_RGB[2] ?? 0) * shadow.alpha,
          shadow.alpha,
        );
        this.#texture(entry.shadow, entry, 2, {
          shadow,
          baseY: groundLine(plant) * t,
        });
      }

      this.#grounds(frame, place, plant.wilting);
      if (entry.stemsFrame !== frame) {
        entry.stems = this.#raster(
          entry,
          at,
          plant,
          (g) => {
            paintStems(g, frame, art, this.#paths);
          },
          entry.stems,
        );
        entry.stemsFrame = frame;
      }
      this.#texture(entry.stems, entry, 1, null, plant.wilting);
      this.#sprites(
        swaySprites(
          frame.sprites,
          still ? null : seconds,
          undefined,
          (sprite) => toDesign(plant, sprite.x, sprite.y),
        ),
        place,
        plant.wilting,
      );
      if (frame.badges.length > 0) {
        entry.badges ??= this.#raster(
          entry,
          at,
          plant,
          (g) => {
            paintBadges(g, frame.badges, badges);
          },
          null,
        );
        this.#texture(entry.badges, entry, 0, null, plant.wilting);
      }
    }
    grassTo(Infinity);
    (gl.canvas as HTMLCanvasElement).dataset.tufts = String(tufts.length);
    for (const [id, entry] of this.#entries)
      if (!seen.has(id)) {
        this.#release(entry);
        this.#entries.delete(id);
      }
    return true;
  }

  /** The plant's entry, emptied when what it shows has changed. */
  #entry(
    plant: PlantDescription,
    at: { k: number; x: number; y: number },
    size: string,
  ): Entry {
    const key = [size, plant.highlighted].join("|");
    const before = this.#entries.get(plant.id);
    if (before?.key === key && before.scene === plant.scene) return before;
    if (before) this.#release(before);
    const margin = Math.ceil(MARGIN * at.k) + 2;
    const entry: Entry = {
      key,
      scene: plant.scene,
      left: Math.floor(at.x) - margin,
      top: Math.floor(at.y) - margin,
      width:
        Math.ceil(plant.bounds.width * at.k + (at.x - Math.floor(at.x))) +
        1 +
        margin * 2,
      height:
        Math.ceil(plant.bounds.height * at.k + (at.y - Math.floor(at.y))) +
        1 +
        margin * 2,
      stems: null,
      stemsFrame: null,
      badges: undefined,
      shadow: undefined,
      outline: undefined,
    };
    this.#entries.set(plant.id, entry);
    return entry;
  }

  #release(entry: Entry): void {
    for (const texture of [
      entry.stems,
      entry.badges,
      entry.shadow,
      entry.outline,
    ])
      if (texture) this.#gl.deleteTexture(texture);
  }

  /** Paint into the scratch canvas in the plant's graph coordinates, sized to the entry. */
  #paint(
    entry: Entry,
    at: { k: number; x: number; y: number },
    plant: PlantDescription,
    draw: (g: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const scratch = this.#scratch;
    scratch.width = entry.width;
    scratch.height = entry.height;
    const g = scratch.getContext("2d");
    if (!g) return scratch;
    g.setTransform(
      at.k,
      0,
      0,
      at.k,
      at.x - entry.left - plant.bounds.x * at.k,
      at.y - entry.top - plant.bounds.y * at.k,
    );
    draw(g);
    return scratch;
  }

  #raster(
    entry: Entry,
    at: { k: number; x: number; y: number },
    plant: PlantDescription,
    draw: (g: CanvasRenderingContext2D) => void,
    texture: WebGLTexture | null,
  ): WebGLTexture {
    return uploadCanvas(this.#gl, this.#paint(entry, at, plant, draw), texture);
  }

  /** The plant at rest, all of it, as its silhouette's source. */
  #atRest(
    plant: PlantDescription,
    at: { k: number; x: number; y: number },
    entry: Entry,
    art: PaintArt,
    badges: BadgeStyle,
  ): HTMLCanvasElement {
    const frame = settledFrame(plant.scene);
    return this.#paint(entry, at, plant, (g) => {
      paintGrounds(g, frame);
      paintStems(g, frame, art, this.#paths);
      paintSprites(g, frame.sprites, art);
      paintBadges(g, frame.badges, badges);
    });
  }

  #shadow(
    plant: PlantDescription,
    at: { k: number; x: number; y: number },
    entry: Entry,
    art: PaintArt,
    badges: BadgeStyle,
  ): WebGLTexture | null {
    const source = this.#atRest(plant, at, entry, art, badges);
    const out = this.#fresh(entry);
    const g = out.getContext("2d");
    if (!g) return null;
    // The shadow's shape, blurred as Software blurs it; the light only
    // casts and fades it.
    castShadows(
      g,
      source,
      entry.width,
      entry.height,
      [{ x: 0, y: 0, blur: PLANT_SHADOW_BLUR, color: "#000" }],
      at.k,
    );
    return uploadCanvas(this.#gl, out, null);
  }

  #outline(
    plant: PlantDescription,
    at: { k: number; x: number; y: number },
    entry: Entry,
    art: PaintArt,
    badges: BadgeStyle,
  ): WebGLTexture | null {
    const source = this.#atRest(plant, at, entry, art, badges);
    // The plant's silhouette in cyan: the outline shows around the plant
    // and, as in Software, through its translucent edges.
    const g0 = source.getContext("2d");
    if (!g0) return null;
    g0.setTransform(1, 0, 0, 1, 0, 0);
    g0.globalCompositeOperation = "source-in";
    g0.fillStyle = OUTLINE[0]?.color ?? "#00e5ff";
    g0.fillRect(0, 0, entry.width, entry.height);
    g0.globalCompositeOperation = "source-over";
    const out = this.#fresh(entry);
    const g = out.getContext("2d");
    if (!g) return null;
    const { width: w, height: h } = entry;
    if (canvasFilters(g)) {
      // The plots' CSS filters exactly: each glow falls from what is drawn
      // so far, so the outline builds up.
      g.filter = OUTLINE.map(
        (c) =>
          `drop-shadow(0px 0px ${(c.blur * at.k).toFixed(2)}px ${c.color})`,
      ).join(" ");
      g.drawImage(source, 0, 0, w, h, 0, 0, w, h);
      g.filter = "none";
    } else {
      castShadows(g, source, w, h, OUTLINE, at.k);
      g.drawImage(source, 0, 0, w, h, 0, 0, w, h);
    }
    return uploadCanvas(this.#gl, out, null);
  }

  /** The second canvas, cleared and sized to the entry. */
  #fresh(entry: Entry): HTMLCanvasElement {
    this.#out.width = entry.width;
    this.#out.height = entry.height;
    return this.#out;
  }

  /**
   * Draw one of the entry's textures over its rectangle, or, given a
   * shadow, laid on the ground from the plant's base at canvas `baseY`.
   */
  #texture(
    texture: WebGLTexture | null | undefined,
    entry: Entry,
    mode: 0 | 1 | 2,
    ground: { shadow: PlantShadow; baseY: number } | null = null,
    wilting = false,
  ): void {
    if (!texture) return;
    const gl = this.#gl;
    const u = this.#quadU;
    gl.useProgram(this.#quad);
    gl.uniform4f(
      u.uRect ?? null,
      entry.left,
      entry.top,
      entry.width,
      entry.height,
    );
    gl.uniform3f(
      u.uGround ?? null,
      ground?.shadow.shear ?? 0,
      ground?.shadow.squash ?? 0,
      ground?.baseY ?? 0,
    );
    gl.uniform1i(u.uMode ?? null, mode);
    gl.uniform1i(u.uWilting ?? null, wilting ? 1 : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(this.#empty);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  #grounds(
    frame: Frame,
    place: [number, number, number],
    wilting: boolean,
  ): void {
    if (frame.grounds.length === 0) return;
    const gl = this.#gl;
    const data = new Float32Array(frame.grounds.length * 3);
    frame.grounds.forEach((ground, i) => {
      data.set([ground.x, ground.y, ground.width / 2], i * 3);
    });
    gl.useProgram(this.#ground);
    gl.uniform3fv(this.#groundU.uPlace ?? null, place);
    gl.uniform1i(this.#groundU.uWilting ?? null, wilting ? 1 : 0);
    gl.bindVertexArray(this.#groundVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#groundBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, frame.grounds.length);
  }

  /** Every tuft's instance at `seconds` (null: at rest), for this frame. */
  #uploadGrass(tufts: readonly Tuft[], seconds: number | null): void {
    const gl = this.#gl;
    const wind = seconds === null ? currentWind() : swayWind(seconds);
    const strength = swayStrength();
    const data = new Float32Array(tufts.length * GRASS_FLOATS);
    tufts.forEach((tuft, i) => {
      const { lean, lift } = tuftPose(
        tuft,
        seconds,
        wind,
        strength,
        MAX_WIND_STRENGTH,
      );
      data.set(
        [
          tuft.x,
          tuft.y,
          tuft.size,
          lean,
          tuft.kind,
          tuft.flip ? 1 : 0,
          tuftSquash(lean),
          lift,
        ],
        i * GRASS_FLOATS,
      );
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#grassBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
  }

  /** Draw tufts `from` up to `to` of this frame's upload. */
  #grassBatch(from: number, to: number): void {
    if (to <= from) return;
    const gl = this.#gl;
    const stride = GRASS_FLOATS * 4;
    gl.useProgram(this.#grass);
    gl.bindVertexArray(this.#grassVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#grassBuffer);
    // WebGL2 has no base instance: point the attributes at the batch.
    const { tuft, cell } = this.#grassAttribs;
    gl.vertexAttribPointer(tuft, 4, gl.FLOAT, false, stride, from * stride);
    gl.vertexAttribPointer(
      cell,
      4,
      gl.FLOAT,
      false,
      stride,
      from * stride + 16,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, to - from);
  }

  #sprites(
    sprites: readonly (Sprite & { alpha: number; scale: number })[],
    place: [number, number, number],
    wilting: boolean,
  ): void {
    if (sprites.length === 0) return;
    const gl = this.#gl;
    const data = new Float32Array(sprites.length * SPRITE_FLOATS);
    sprites.forEach((s, i) => {
      data.set(
        [s.x, s.y, s.size * s.scale, s.rotate, s.kind, s.flip ? 1 : 0, s.alpha],
        i * SPRITE_FLOATS,
      );
    });
    gl.useProgram(this.#sprite);
    gl.uniform3fv(this.#spriteU.uPlace ?? null, place);
    gl.uniform1i(this.#spriteU.uWilting ?? null, wilting ? 1 : 0);
    gl.bindVertexArray(this.#spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sprites.length);
  }
}

let silhouettes: Promise<PaintArt> | null = null;

/**
 * The unlit sprite atlas at the Canvas painters' cell size, and its
 * mirror, for silhouettes (shadows, outlines): only their alpha matters.
 */
function silhouetteArt(albedo: ImageBitmap): Promise<PaintArt> {
  silhouettes ??= (async () => {
    const size = CELL_SIZE * 2;
    const sprites = await createImageBitmap(albedo, {
      resizeWidth: size,
      resizeHeight: size,
      resizeQuality: "high",
    });
    const mirrored = new OffscreenCanvas(size, size);
    const g = mirrored.getContext("2d");
    if (g)
      for (let row = 0; row < 2; row++)
        for (let column = 0; column < 2; column++) {
          // Each cell mirrored in place, as mirrorCells (relight.ts) does.
          g.setTransform(-1, 0, 0, 1, (column + 1) * CELL_SIZE, 0);
          g.drawImage(
            sprites,
            column * CELL_SIZE,
            row * CELL_SIZE,
            CELL_SIZE,
            CELL_SIZE,
            0,
            row * CELL_SIZE,
            CELL_SIZE,
            CELL_SIZE,
          );
        }
    return { sprites, spritesMirrored: mirrored, palette: {} };
  })();
  return silhouettes;
}
