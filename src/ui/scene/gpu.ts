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
import hillAlbedo from "../assets/scene/hill-albedo.png";
import hillNormal from "../assets/scene/hill-normal.png";
import hillTranslucency from "../assets/scene/hill-translucency.png";
import ridgeAlbedo from "../assets/scene/ridge-albedo.png";
import ridgeNormal from "../assets/scene/ridge-normal.png";
import type { LightingState } from "../../environment/lighting.ts";
import { LAYERS, RIM_GAIN, WRAP, type LayerLight } from "./shading.ts";
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
void main() {
  vec2 uv = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0,
                 gl_VertexID >= 2 ? 1.0 : 0.0);
  vUv = uv;
  vec2 p = uRect.xy + uv * uRect.zw;
  gl_Position = vec4(p / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

/** `shade` (shading.ts) per pixel, with relight.ts's map decoding. */
const LIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uTranslucency;
uniform bool uHasMap;
uniform bool uFlipX;
uniform vec3 uSunDir, uSun, uMoonDir, uMoon, uSunFill, uMoonFill, uAmbient, uHorizon;
uniform float uHaze, uTranslucencyScale, uFill;
uniform float uLayerHaze, uLayerTranslucency;
in vec2 vUv;
out vec4 color;
const float WRAP = ${WRAP.toFixed(6)};
const float RIM_GAIN = ${RIM_GAIN.toFixed(6)};
float diffuse(vec3 n, vec3 l) { return max(0.0, (dot(n, l) + WRAP) / (1.0 + WRAP)); }
float through(vec3 n, vec3 l) { return max(0.0, -dot(n, l)); }
void main() {
  vec4 a = texture(uAlbedo, vUv);
  // cleanAlpha: the image tool's noisy key, snapped at both ends.
  if (a.a < 8.0 / 255.0) discard;
  float alpha = a.a >= 240.0 / 255.0 ? 1.0 : a.a;
  vec3 albedo = pow(a.rgb / a.a, vec3(2.2));
  vec3 n = texture(uNormal, vUv).rgb * 2.0 - 1.0;
  if (uFlipX) n.x = -n.x;
  n = normalize(n);
  float map = uHasMap
    ? dot(texture(uTranslucency, vUv).rgb, vec3(0.299, 0.587, 0.114))
    : uLayerTranslucency;
  float t = map * uTranslucencyScale;
  float f = uFill;
  float sun = diffuse(n, uSunDir) + t * through(n, uSunDir) + f * diffuse(n, uSunFill);
  float moon = diffuse(n, uMoonDir) + t * through(n, uMoonDir) + f * diffuse(n, uMoonFill);
  // Sky light from above, a little less on faces turned down.
  float hemi = 0.75 + 0.25 * n.y;
  // Backlight catches silhouettes when the light is behind the scene.
  float edge = 1.0 - max(0.0, n.z);
  float rim = RIM_GAIN * edge * edge * edge * max(0.0, -uSunDir.z) * max(0.0, uSunDir.y + 0.2);
  vec3 light = uAmbient * hemi + uSun * (sun + rim) + uMoon * moon;
  vec3 lit = albedo * light;
  float h = uLayerHaze * uHaze;
  lit = lit + (uHorizon * 0.8 - lit) * h;
  vec3 srgb = pow(clamp(lit, 0.0, 1.0), vec3(1.0 / 2.2));
  color = vec4(srgb * alpha, alpha);
}`;

interface LayerMaps {
  albedo: ImageBitmap;
  normal: ImageBitmap;
  translucency: ImageBitmap | null;
}

interface Maps {
  ridge: LayerMaps;
  hill: LayerMaps;
}

async function bitmap(url: string, premultiply: boolean): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  // WebGL ignores its unpack flags for ImageBitmaps: decode as uploaded.
  // Albedo is premultiplied so filtering never bleeds the transparent key
  // color; maps are data, never color-managed.
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: premultiply ? "premultiply" : "none",
    colorSpaceConversion: "none",
  });
}

let maps: Promise<Maps> | null = null;

/** The landscape's maps, decoded once per page and kept across lost contexts. */
function loadMaps(): Promise<Maps> {
  maps ??= Promise.all([
    bitmap(ridgeAlbedo, true),
    bitmap(ridgeNormal, false),
    bitmap(hillAlbedo, true),
    bitmap(hillNormal, false),
    bitmap(hillTranslucency, false),
  ]).then(([ra, rn, ha, hn, ht]) => ({
    ridge: { albedo: ra, normal: rn, translucency: null },
    hill: { albedo: ha, normal: hn, translucency: ht },
  }));
  maps.catch(() => {
    maps = null;
  });
  return maps;
}

function compile(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error("createShader failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (
      !(gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean) &&
      !gl.isContextLost()
    )
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (
    !(gl.getProgramParameter(program, gl.LINK_STATUS) as boolean) &&
    !gl.isContextLost()
  )
    throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  return program;
}

function upload(gl: WebGL2RenderingContext, image: ImageBitmap): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

interface LayerTextures {
  albedo: WebGLTexture;
  normal: WebGLTexture;
  translucency: WebGLTexture | null;
  light: LayerLight;
  /** The Codex hill normal map came back with its X axis inverted (relight.ts). */
  flipX: boolean;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly string[],
): Uniforms {
  return Object.fromEntries(
    names.map((name) => [name, gl.getUniformLocation(program, name)]),
  );
}

/** Options for the GPU tier's context (ADR 0018, "Choosing a tier"). */
export const CONTEXT: WebGLContextAttributes = {
  powerPreference: "low-power",
  antialias: false,
  alpha: false,
  premultipliedAlpha: true,
  // The landscape is drawn only when the light or size changes, so the
  // last frame must survive compositing (and can be read back by tests).
  preserveDrawingBuffer: true,
};

export class LandscapeGpu {
  readonly #gl: WebGL2RenderingContext;
  readonly #sky: WebGLProgram;
  readonly #star: WebGLProgram;
  readonly #lit: WebGLProgram;
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
  static create(canvas: HTMLCanvasElement): LandscapeGpu | null {
    const gl = canvas.getContext("webgl2", CONTEXT);
    return gl === null || gl.isContextLost() ? null : new LandscapeGpu(gl);
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#sky = compile(gl, FULL_VS, SKY_FS);
    this.#star = compile(gl, STAR_VS, STAR_FS);
    this.#lit = compile(gl, LAYER_VS, LIT_FS);
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
      "uSunDir",
      "uSun",
      "uMoonDir",
      "uMoon",
      "uSunFill",
      "uMoonFill",
      "uAmbient",
      "uHorizon",
      "uHaze",
      "uTranslucencyScale",
      "uFill",
      "uLayerHaze",
      "uLayerTranslucency",
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
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer =
      info === null
        ? String(gl.getParameter(gl.RENDERER))
        : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
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
      albedo: upload(gl, m.albedo),
      normal: upload(gl, m.normal),
      translucency: m.translucency === null ? null : upload(gl, m.translucency),
      light,
      flipX,
    });
    this.#layers = [
      layer(decoded.ridge, LAYERS.ridge, false),
      layer(decoded.hill, LAYERS.hill, true),
    ];
  }

  /** Release the context and its textures now (the tier was switched away). */
  dispose(): void {
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Draw the whole landscape for `state`. Returns whether the layers were drawn. */
  draw(state: LightingState): boolean {
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
      gl.uniform3f(u.uSunDir ?? null, p.sunDir.x, p.sunDir.y, p.sunDir.z);
      gl.uniform3fv(u.uSun ?? null, p.sun);
      gl.uniform3f(u.uMoonDir ?? null, p.moonDir.x, p.moonDir.y, p.moonDir.z);
      gl.uniform3fv(u.uMoon ?? null, p.moon);
      gl.uniform3f(u.uSunFill ?? null, p.sunFill.x, p.sunFill.y, p.sunFill.z);
      gl.uniform3f(
        u.uMoonFill ?? null,
        p.moonFill.x,
        p.moonFill.y,
        p.moonFill.z,
      );
      gl.uniform3fv(u.uAmbient ?? null, p.ambient);
      gl.uniform3fv(u.uHorizon ?? null, p.horizon);
      gl.uniform1f(u.uHaze ?? null, p.haze);
      gl.uniform1f(u.uTranslucencyScale ?? null, p.translucency);
      for (const layer of layers) {
        gl.uniform1f(u.uLayerHaze ?? null, layer.light.haze);
        gl.uniform1f(u.uLayerTranslucency ?? null, layer.light.translucency);
        gl.uniform1f(u.uFill ?? null, layer.light.fill ? p.fill : 0);
        gl.uniform1i(u.uHasMap ?? null, layer.translucency === null ? 0 : 1);
        gl.uniform1i(u.uFlipX ?? null, layer.flipX ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer.albedo);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer.normal);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, layer.translucency ?? layer.normal);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    return layers !== null;
  }
}
