/**
 * The GPU tier's landscape (ADR 0018, step 4): hand-written WebGL2, no
 * library. One full-screen pass draws the sky, Sun, and Moon; the stars are
 * points; the ridge and hill are relit per pixel from their albedo, normal,
 * and translucency maps with a shader that mirrors `shade` (shading.ts)
 * line for line, so the two tiers differ only in when light is computed.
 *
 * Everything is drawn from the same `LightingState` and `view.ts` geometry
 * as the software tier's SceneCanvas.
 */
import type { LightingState } from "../../environment/lighting.ts";
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
  type LayerMaps,
  type Uniforms,
} from "./gl.ts";
import { LAYERS, type LayerLight } from "./shading.ts";
import type { GpuRenderer } from "./useGpu.ts";
import {
  DESIGN,
  MOON_COLOR,
  sceneLight,
  skyBodies,
  transform,
} from "./view.ts";

const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * The sky in two passes around the stars, in SceneCanvas's order: the
 * gradient, then (uBodies) the Sun's glow and disc and the Moon's phase as
 * premultiplied coverage over what is drawn.
 */
const SKY_FS = `#version 300 es
precision highp float;
uniform bool uBodies;
uniform vec2 uResolution;
uniform vec3 uZenith, uHorizon;
uniform float uHorizonY;
uniform vec4 uSun;       // x, y, radius, glow radius
uniform vec4 uSunColor;  // rgb, alpha (0: no Sun)
uniform vec4 uMoon;      // x, y, radius, alpha (0: no Moon)
uniform vec3 uMoonS;
uniform vec3 uMoonColor;
out vec4 color;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  if (!uBodies) {
    color = vec4(mix(uZenith, uHorizon, clamp(p.y / uHorizonY, 0.0, 1.0)), 1.0);
    return;
  }
  vec4 c = vec4(0.0);
  if (uSunColor.a > 0.0) {
    float d = distance(p, uSun.xy);
    float f = clamp(d / uSun.w, 0.0, 1.0);
    float glow = (1.0 - f) * (1.0 - f) * 0.55 * uSunColor.a;
    float disc = clamp(uSun.z - d + 0.5, 0.0, 1.0) * uSunColor.a;
    float a = 1.0 - (1.0 - glow) * (1.0 - disc);
    c = vec4(uSunColor.rgb * a, a);
  }
  if (uMoon.w > 0.0) {
    vec2 q = (p - uMoon.xy) / uMoon.z;
    q.y = -q.y;
    float r = length(q);
    if (r <= 1.03) {
      float z = sqrt(max(0.0, 1.0 - dot(q, q)));
      float t = clamp((dot(vec3(q, z), uMoonS) + 0.04) / 0.08, 0.0, 1.0);
      // Earthshine keeps the dark side faintly visible (view.ts moonLight).
      float lit = 0.07 + 0.93 * t * t * (3.0 - 2.0 * t);
      float edge = 1.0 - clamp((r - 0.97) / 0.06, 0.0, 1.0);
      // Unlit parts let the sky through.
      float m = edge * (0.3 + 0.7 * lit) * uMoon.w;
      c = vec4(uMoonColor * m, m) + c * (1.0 - m);
    }
  }
  if (c.a <= 0.0) discard;
  color = c;
}`;

const STAR_VS = `#version 300 es
uniform vec2 uResolution;
in vec4 aStar; // x, y, radius, alpha
out float vRadius;
out float vAlpha;
void main() {
  vRadius = aStar.z;
  vAlpha = aStar.w;
  gl_PointSize = ceil(aStar.z * 2.0 + 2.0);
  gl_Position = vec4(aStar.xy / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const STAR_FS = `#version 300 es
precision highp float;
in float vRadius;
in float vAlpha;
out vec4 color;
void main() {
  float d = length(gl_PointCoord - 0.5) * ceil(vRadius * 2.0 + 2.0);
  float a = clamp(vRadius - d + 0.5, 0.0, 1.0) * vAlpha;
  color = vec4(vec3(242.0, 245.0, 255.0) / 255.0 * a, a);
}`;

/** One layer's quad: the 1920×1080 design space under the cover transform. */
const LAYER_VS = `#version 300 es
uniform vec4 uRect; // x, y, width, height in canvas pixels
uniform vec2 uResolution;
out vec2 vUv;
${TO_CLIP_GLSL}
void main() {
  vec2 uv = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0,
                 gl_VertexID >= 2 ? 1.0 : 0.0);
  vUv = uv;
  vec2 p = uRect.xy + uv * uRect.zw;
  gl_Position = toClip(p, uResolution);
}`;

/** `shade` (shading.ts) per pixel, with relight.ts's map decoding. */
const LIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uTranslucency;
uniform bool uHasMap;
uniform bool uFlipX;
uniform float uLayerHaze, uLayerTranslucency, uLayerFill, uLayerNight;
in vec2 vUv;
out vec4 color;
${SHADE_GLSL}
void main() {
  float map = uHasMap ? luminance(texture(uTranslucency, vUv).rgb) : uLayerTranslucency;
  color = shadeTexel(texture(uAlbedo, vUv), texture(uNormal, vUv).rgb, uFlipX,
                     map, uLayerFill, uLayerHaze, uLayerNight);
  if (color.a <= 0.0) discard;
}`;

/** A premultiplied overlay drawn one to one (the sky's weather). */
const OVERLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D uImage;
in vec2 vUv;
out vec4 color;
void main() {
  color = texture(uImage, vUv);
  if (color.a <= 0.0) discard;
}`;

interface LayerTextures {
  albedo: WebGLTexture;
  normal: WebGLTexture;
  translucency: WebGLTexture | null;
  light: LayerLight;
  /** A normal map whose X axis points left (relight.ts); none at present. */
  flipX: boolean;
}

export class LandscapeGpu implements GpuRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #sky: WebGLProgram;
  readonly #star: WebGLProgram;
  readonly #lit: WebGLProgram;
  readonly #overlayProgram: WebGLProgram;
  readonly #overlayU: Uniforms;
  /** Uploaded weather rasters, by kind, with the key of what is in each. */
  readonly #weather = {
    clouds: { texture: null as WebGLTexture | null, key: "" },
    rainbow: { texture: null as WebGLTexture | null, key: "" },
  };
  readonly #skyU: Uniforms;
  readonly #starU: Uniforms;
  readonly #litU: Uniforms;
  readonly #stars: WebGLBuffer;
  readonly #starVao: WebGLVertexArrayObject;
  readonly #empty: WebGLVertexArrayObject;
  #layers: LayerTextures[] | null = null;
  /** The renderer's name, for diagnostics. */
  readonly renderer: string;

  /** Null without WebGL2. The caller decided whether software WebGL is acceptable. */
  static readonly create = (canvas: HTMLCanvasElement): LandscapeGpu | null => {
    const gl = canvas.getContext("webgl2", { ...CONTEXT, alpha: false });
    return gl === null || gl.isContextLost() ? null : new LandscapeGpu(gl);
  };

  private constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#sky = compile(gl, FULL_VS, SKY_FS);
    this.#star = compile(gl, STAR_VS, STAR_FS);
    this.#lit = compile(gl, LAYER_VS, LIT_FS);
    this.#overlayProgram = compile(gl, LAYER_VS, OVERLAY_FS);
    this.#overlayU = uniforms(gl, this.#overlayProgram, [
      "uRect",
      "uResolution",
      "uImage",
    ]);
    this.#skyU = uniforms(gl, this.#sky, [
      "uBodies",
      "uResolution",
      "uZenith",
      "uHorizon",
      "uHorizonY",
      "uSun",
      "uSunColor",
      "uMoon",
      "uMoonS",
      "uMoonColor",
    ]);
    this.#starU = uniforms(gl, this.#star, ["uResolution"]);
    this.#litU = uniforms(gl, this.#lit, [
      "uRect",
      "uResolution",
      "uAlbedo",
      "uNormal",
      "uTranslucency",
      "uHasMap",
      "uFlipX",
      "uLayerHaze",
      "uLayerTranslucency",
      "uLayerFill",
      "uLayerNight",
      ...LIGHT_UNIFORMS,
    ]);
    this.#stars = gl.createBuffer();
    this.#starVao = gl.createVertexArray();
    gl.bindVertexArray(this.#starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#stars);
    const location = gl.getAttribLocation(this.#star, "aStar");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 0, 0);
    this.#empty = gl.createVertexArray();
    gl.bindVertexArray(null);
    this.renderer = rendererName(gl);
  }

  /** Upload the ridge and hill maps; until then, `draw` shows the sky alone. */
  async load(): Promise<void> {
    const decoded = await loadMaps();
    const gl = this.#gl;
    if (gl.isContextLost()) return;
    const layer = (
      m: LayerMaps,
      light: LayerLight,
      flipX: boolean,
    ): LayerTextures => ({
      albedo: uploadMap(gl, m.albedo),
      normal: uploadMap(gl, m.normal),
      translucency:
        m.translucency === null ? null : uploadMap(gl, m.translucency),
      light,
      flipX,
    });
    this.#layers = [
      layer(decoded.ridge, LAYERS.ridge, false),
      layer(decoded.hill, LAYERS.hill, false),
    ];
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

  /** Release the context and its textures now (the tier was switched away). */
  dispose(): void {
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /**
   * Draw the whole landscape for `state`, with the sky's weather when
   * given (weather-sky.ts): clouds over the Sun and Moon, a rainbow in
   * front of the ridge. Rasters upload only when their keys change.
   * Returns whether the layers were drawn.
   */
  draw(
    state: LightingState,
    weather: {
      /** The clouds' raster, the canvas pixels it spans across. */
      clouds: { canvas: HTMLCanvasElement; key: string; span: number } | null;
      rainbow: { canvas: HTMLCanvasElement; key: string } | null;
      /** Where its copies' left edges go (weather-sky.ts cloudPlaces). */
      cloudPlaces?: readonly number[];
    } = { clouds: null, rainbow: null },
  ): boolean {
    const gl = this.#gl;
    if (gl.isContextLost()) return false;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width;
    const H = canvas.height;
    const t = transform(W, H);
    const sky = skyBodies(t, state);
    gl.viewport(0, 0, W, H);

    gl.disable(gl.BLEND);
    gl.useProgram(this.#sky);
    const s = this.#skyU;
    gl.uniform1i(s.uBodies ?? null, 0);
    gl.uniform2f(s.uResolution ?? null, W, H);
    gl.uniform3fv(s.uZenith ?? null, state.sky.zenith);
    gl.uniform3fv(s.uHorizon ?? null, state.sky.horizon);
    gl.uniform1f(s.uHorizonY ?? null, sky.horizonY);
    gl.uniform4f(
      s.uSun ?? null,
      sky.sun?.x ?? 0,
      sky.sun?.y ?? 0,
      sky.sun?.r ?? 1,
      sky.sun?.glow ?? 1,
    );
    gl.uniform4f(s.uSunColor ?? null, ...state.sun.color, sky.sun?.alpha ?? 0);
    gl.uniform4f(
      s.uMoon ?? null,
      sky.moon?.x ?? 0,
      sky.moon?.y ?? 0,
      sky.moon?.r ?? 1,
      sky.moon?.alpha ?? 0,
    );
    gl.uniform3fv(s.uMoonS ?? null, sky.moon?.s ?? [0, 0, 1]);
    gl.uniform3fv(s.uMoonColor ?? null, MOON_COLOR);
    gl.bindVertexArray(this.#empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (sky.stars.length > 0) {
      gl.useProgram(this.#star);
      gl.uniform2f(this.#starU.uResolution ?? null, W, H);
      gl.bindVertexArray(this.#starVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#stars);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array(sky.stars.flatMap((p) => [p.x, p.y, p.r, p.a])),
        gl.STREAM_DRAW,
      );
      gl.drawArrays(gl.POINTS, 0, sky.stars.length);
    }
    if (sky.sun !== null || sky.moon !== null) {
      gl.useProgram(this.#sky);
      gl.uniform1i(s.uBodies ?? null, 1);
      gl.bindVertexArray(this.#empty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    for (const x of weather.cloudPlaces ?? [])
      this.#overlay(weather.clouds, "clouds", W, H, [
        x,
        0,
        weather.clouds?.span ?? W,
        H,
      ]);

    const layers = this.#layers;
    if (layers !== null) {
      const p = sceneLight(state);
      const u = this.#litU;
      gl.useProgram(this.#lit);
      gl.bindVertexArray(this.#empty);
      gl.uniform2f(u.uResolution ?? null, W, H);
      gl.uniform4f(
        u.uRect ?? null,
        t.ox,
        t.oy,
        DESIGN.width * t.scale,
        DESIGN.height * t.scale,
      );
      gl.uniform1i(u.uAlbedo ?? null, 0);
      gl.uniform1i(u.uNormal ?? null, 1);
      gl.uniform1i(u.uTranslucency ?? null, 2);
      setLight(gl, u, p);
      layers.forEach((layer, index) => {
        if (index === 1 && weather.rainbow !== null) {
          // The rain a rainbow shines in is nearer than the ridge.
          this.#overlay(weather.rainbow, "rainbow", W, H);
          gl.useProgram(this.#lit);
          gl.bindVertexArray(this.#empty);
        }
        gl.uniform1f(u.uLayerHaze ?? null, layer.light.haze);
        gl.uniform1f(u.uLayerTranslucency ?? null, layer.light.translucency);
        gl.uniform1f(u.uLayerFill ?? null, layer.light.fill ? 1 : 0);
        gl.uniform1f(u.uLayerNight ?? null, layer.light.night);
        gl.uniform1i(u.uHasMap ?? null, layer.translucency === null ? 0 : 1);
        gl.uniform1i(u.uFlipX ?? null, layer.flipX ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer.albedo);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer.normal);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, layer.translucency ?? layer.normal);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      });
    } else {
      this.#overlay(weather.rainbow, "rainbow", W, H);
    }
    return layers !== null;
  }

  /**
   * Draw a premultiplied raster over the whole canvas, or over `rect` (x, y,
   * width, height in canvas pixels), uploading it if new.
   */
  #overlay(
    raster: { canvas: HTMLCanvasElement; key: string } | null,
    kind: "clouds" | "rainbow",
    W: number,
    H: number,
    rect: readonly [number, number, number, number] = [0, 0, W, H],
  ): void {
    if (raster === null) return;
    const gl = this.#gl;
    const slot = this.#weather[kind];
    if (raster.key !== slot.key || slot.texture === null) {
      slot.texture = uploadCanvas(gl, raster.canvas, slot.texture);
      slot.key = raster.key;
    }
    // The rainbow is light the rain sends back: it adds to the scene.
    if (kind === "rainbow") gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.#overlayProgram);
    gl.bindVertexArray(this.#empty);
    gl.uniform2f(this.#overlayU.uResolution ?? null, W, H);
    gl.uniform4f(this.#overlayU.uRect ?? null, ...rect);
    gl.uniform1i(this.#overlayU.uImage ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}
