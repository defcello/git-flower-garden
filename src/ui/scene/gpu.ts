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
import { swayWind, windStrength } from "../sway.ts";
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
import { WIND_GLSL, WIND_LATTICE } from "./wind-field.ts";
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

/** Above this share of the art's height, the hill has no grass. */
const HILL_TOP = 0.6;

/** A cached framebuffer copied one to one (the landscape behind the hill). */
const BACKDROP_FS = `#version 300 es
precision highp float;
uniform sampler2D uImage;
out vec4 color;
void main() { color = texelFetch(uImage, ivec2(gl_FragCoord.xy), 0); }`;

/**
 * The wind in the grass (wind-field.ts): the hill, relit once per light
 * change, sampled where the wind leans its blades. Only the painted blade
 * detail moves (no sliding sheet), more at the front than up the hill, and
 * the alpha stays where it was, so the crest never moves. Where the grass
 * bends, its blades show lighter, less saturated sides: the travelling
 * bands that make wind visible across a field.
 */
const WAVE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uLit, uAlbedo, uTranslucency;
uniform highp sampler2D uLattice;
uniform vec4 uView; // the cover transform: ox, oy, scale; canvas height
uniform float uSeconds, uSpeed, uWindX, uTravel, uStrength, uDaylight;
out vec4 color;
${SHADE_GLSL}
${WIND_GLSL}
void main() {
  vec2 size = vec2(textureSize(uLit, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec4 here = texture(uLit, uv);
  if (here.a <= 0.0) discard;
  vec2 p = (vec2(gl_FragCoord.x, uView.w - gl_FragCoord.y) - uView.xy) / uView.z;
  vec2 art = p / vec2(1920.0, 1080.0);
  float bend = windWave(p, uSeconds, uSpeed, uWindX, uTravel);
  float a = luminance(texture(uAlbedo, art + vec2(2.0 / 1920.0, 0.0)).rgb);
  float b = luminance(texture(uAlbedo, art - vec2(2.0 / 1920.0, 0.0)).rgb);
  float detail = smoothstep(0.012, 0.11, abs(a - b));
  float depth = smoothstep(610.0, 1080.0, p.y);
  float interior = smoothstep(0.6, 0.95, texture(uAlbedo, art).a);
  float wind = min(uStrength, 2.2);
  float lean = bend * detail * interior * mix(1.5, 6.0, depth) * wind;
  color = texture(uLit, uv - vec2(lean * uView.z / size.x, 0.0));
  color.rgb *= here.a / max(color.a, 0.001);
  color.a = here.a;
  // Bent blades show their lighter, paler sides; upright grass between the
  // waves stands darker. Crisp enough to read as patches, even on a phone.
  float map = luminance(texture(uTranslucency, art).rgb);
  float weight = (0.5 + 0.5 * map) * (0.6 + 0.4 * detail) * wind / 2.2;
  float sheen = smoothstep(0.05, 0.5, bend) * uDaylight * weight * 0.32;
  float shade = smoothstep(0.05, 0.5, -bend) * weight * 0.22;
  color.rgb = mix(color.rgb, vec3(luminance(color.rgb)), sheen * 0.5);
  color.rgb += vec3(0.82, 0.94, 0.72) * sheen * color.a;
  color.rgb *= 1.0 - shade;
}`;

interface LayerTextures {
  albedo: WebGLTexture;
  normal: WebGLTexture;
  translucency: WebGLTexture | null;
  light: LayerLight;
  /** The Codex hill normal map came back with its X axis inverted (relight.ts). */
  flipX: boolean;
}

export class LandscapeGpu implements GpuRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #sky: WebGLProgram;
  readonly #star: WebGLProgram;
  readonly #lit: WebGLProgram;
  readonly #overlayProgram: WebGLProgram;
  readonly #backdropProgram: WebGLProgram;
  readonly #wave: WebGLProgram;
  /** The wind's noise lattice (wind-field.ts), shared with the CPU. */
  readonly #lattice: WebGLTexture;
  readonly #waveU: Uniforms;
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
  /** While the grass moves: the landscape behind the hill, and the lit hill. */
  #backdrop: Target | null = null;
  #litHill: Target | null = null;
  /** What the two targets were drawn for. */
  #targetKey = "";
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
    this.#backdropProgram = compile(gl, FULL_VS, BACKDROP_FS);
    this.#wave = compile(gl, FULL_VS, WAVE_FS);
    this.#lattice = latticeTexture(gl);
    this.#waveU = uniforms(gl, this.#wave, [
      "uLattice",
      "uLit",
      "uAlbedo",
      "uTranslucency",
      "uView",
      "uSeconds",
      "uSpeed",
      "uWindX",
      "uTravel",
      "uStrength",
      "uDaylight",
    ]);
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
      layer(decoded.hill, LAYERS.hill, true),
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
      clouds: { canvas: HTMLCanvasElement; key: string } | null;
      rainbow: { canvas: HTMLCanvasElement; key: string } | null;
    } = { clouds: null, rainbow: null },
    seconds: number | null = null,
  ): boolean {
    const gl = this.#gl;
    if (gl.isContextLost()) return false;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width;
    const H = canvas.height;
    // At rest, everything is drawn directly, exactly as before the wind.
    if (seconds === null) return this.#paint(state, weather, "all");
    const layers = this.#layers;
    if (layers === null) return this.#paint(state, weather, "all");
    // While the grass moves, everything behind the hill and the relit hill
    // are drawn once per change of light, weather, or size; each frame only
    // copies the one and leans the blades of the other.
    const key = [
      JSON.stringify(state),
      weather.clouds?.key ?? "",
      weather.rainbow?.key ?? "",
    ].join("|");
    const backdrop = (this.#backdrop = target(gl, this.#backdrop, W, H));
    const lit = (this.#litHill = target(gl, this.#litHill, W, H));
    if (this.#targetKey !== key || backdrop.fresh || lit.fresh) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, backdrop.buffer);
      this.#paint(state, weather, "backdrop");
      gl.bindFramebuffer(gl.FRAMEBUFFER, lit.buffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.#paint(state, weather, "hill");
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      backdrop.fresh = lit.fresh = false;
      this.#targetKey = key;
    }
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.#backdropProgram);
    gl.bindVertexArray(this.#empty);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const hill = layers[1];
    if (hill === undefined) return true;
    const t = transform(W, H);
    const wind = swayWind(seconds);
    const u = this.#waveU;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.#wave);
    gl.uniform1i(u.uLit ?? null, 0);
    gl.uniform1i(u.uAlbedo ?? null, 1);
    gl.uniform1i(u.uTranslucency ?? null, 2);
    gl.uniform1i(u.uLattice ?? null, 3);
    gl.uniform4f(u.uView ?? null, t.ox, t.oy, t.scale, H);
    gl.uniform1f(u.uSeconds ?? null, seconds);
    gl.uniform1f(u.uSpeed ?? null, wind.speed);
    gl.uniform1f(u.uWindX ?? null, wind.windX);
    gl.uniform1f(u.uTravel ?? null, wind.travel);
    gl.uniform1f(u.uStrength ?? null, windStrength(wind.speed));
    gl.uniform1f(u.uDaylight ?? null, state.sun.intensity);
    // Only the rows the hill covers (its crest is at 0.622 of the art's
    // height at the highest).
    const top = Math.max(
      0,
      Math.floor(t.oy + HILL_TOP * DESIGN.height * t.scale),
    );
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, W, Math.max(0, H - top));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, lit.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hill.albedo);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, hill.translucency ?? hill.albedo);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.#lattice);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    return true;
  }

  #paint(
    state: LightingState,
    weather: {
      clouds: { canvas: HTMLCanvasElement; key: string } | null;
      rainbow: { canvas: HTMLCanvasElement; key: string } | null;
    },
    /** Everything, everything behind the hill, or the hill alone. */
    mode: "all" | "backdrop" | "hill",
  ): boolean {
    const gl = this.#gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width,
      H = canvas.height;
    const t = transform(W, H);
    const sky = mode === "hill" ? null : skyBodies(t, state);
    gl.viewport(0, 0, W, H);
    if (sky !== null) {
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
      gl.uniform4f(
        s.uSunColor ?? null,
        ...state.sun.color,
        sky.sun?.alpha ?? 0,
      );
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

      this.#overlay(weather.clouds, "clouds", W, H);
    }

    if (mode === "hill") {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
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
        if (mode === "hill" && index === 0) return;
        if (mode === "backdrop" && index === 1) return;
        if (index === 1 && mode === "all" && weather.rainbow !== null) {
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
      if (mode === "backdrop") this.#overlay(weather.rainbow, "rainbow", W, H);
    } else if (mode !== "hill") {
      this.#overlay(weather.rainbow, "rainbow", W, H);
    }
    return layers !== null;
  }

  /** Draw a premultiplied raster over the whole canvas, uploading it if new. */
  #overlay(
    raster: { canvas: HTMLCanvasElement; key: string } | null,
    kind: "clouds" | "rainbow",
    W: number,
    H: number,
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
    gl.uniform4f(this.#overlayU.uRect ?? null, 0, 0, W, H);
    gl.uniform1i(this.#overlayU.uImage ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

/** The wind's 128×128 noise lattice as an R32F texture, read with texelFetch. */
function latticeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Float textures cannot be filtered without an extension; texelFetch
  // never filters, but the texture must still be complete.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    128,
    128,
    0,
    gl.RED,
    gl.FLOAT,
    WIND_LATTICE,
  );
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return texture;
}

/** A framebuffer with a texture the size of the canvas. */
interface Target {
  texture: WebGLTexture;
  buffer: WebGLFramebuffer;
  width: number;
  height: number;
  /** Made or resized since it was last drawn. */
  fresh: boolean;
}

/** `current` if it still fits a W×H canvas, else a new target (linear, for leaning). */
function target(
  gl: WebGL2RenderingContext,
  current: Target | null,
  W: number,
  H: number,
): Target {
  if (current !== null && current.width === W && current.height === H)
    return current;
  if (current !== null) {
    gl.deleteFramebuffer(current.buffer);
    gl.deleteTexture(current.texture);
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    W,
    H,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  const buffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, buffer, width: W, height: H, fresh: true };
}
