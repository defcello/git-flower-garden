/**
 * The GPU tier of the spike: hand-written WebGL2 (ADR 0018), relighting every
 * texel from its albedo and normal with the real Sun and Moon each frame.
 */
import type { LightingState } from "../../src/environment/lighting.ts";
import type { LayerArt, NormalSource, Pixels } from "./art.ts";
import {
  LAYERS,
  lightParams,
  RIM_GAIN,
  WRAP,
  type Adjustments,
  type LayerLight,
} from "./shading.ts";
import {
  layerQuad,
  MOON_COLOR,
  shadows,
  skyBodies,
  spriteQuads,
  transform,
  type Quad,
} from "./view.ts";

const SKY_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec3 uZenith, uHorizon;
uniform float uHorizonY;
uniform vec4 uSun;       // x, y, radius, glow radius
uniform vec4 uSunColor;  // rgb, alpha
uniform vec4 uMoon;      // x, y, radius, alpha
uniform vec3 uMoonS;
uniform vec3 uMoonColor;
out vec4 color;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec3 c = mix(uZenith, uHorizon, clamp(p.y / uHorizonY, 0.0, 1.0));
  if (uSunColor.a > 0.0) {
    float d = distance(p, uSun.xy);
    float glow = pow(max(0.0, 1.0 - d / uSun.w), 2.0) * 0.55;
    float disc = 1.0 - smoothstep(uSun.z - 1.5, uSun.z + 1.5, d);
    c = mix(c, uSunColor.rgb, clamp((glow + disc) * uSunColor.a, 0.0, 1.0));
  }
  if (uMoon.w > 0.0) {
    vec2 q = (p - uMoon.xy) / uMoon.z;
    q.y = -q.y;
    float r = length(q);
    if (r < 1.05) {
      float z = sqrt(max(0.0, 1.0 - r * r));
      float t = clamp((dot(vec3(q, z), uMoonS) + 0.04) / 0.08, 0.0, 1.0);
      float lit = 0.07 + 0.93 * t * t * (3.0 - 2.0 * t);
      float edge = 1.0 - smoothstep(0.97, 1.03, r);
      c = mix(c, uMoonColor * lit + c * (1.0 - lit) * 0.3, edge * uMoon.w);
    }
  }
  color = vec4(c, 1.0);
}`;

const QUAD_VS = `#version 300 es
uniform vec2 uResolution;
in vec2 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const LIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uTranslucency;
uniform int uTranslucencyMap; // 1: per-texel map; 0: the layer's constant
uniform vec3 uSunDir, uSun, uMoonDir, uMoon, uSunFill, uMoonFill, uAmbient, uHorizon;
uniform float uHaze, uLayerHaze, uLayerTranslucency, uLayerFill;
uniform int uMode; // 0 lit, 1 normals, 2 albedo, 3 translucency
in vec2 vUv;
out vec4 color;
const float WRAP = ${WRAP.toFixed(4)};
const float RIM = ${RIM_GAIN.toFixed(4)};
float diffuse(vec3 n, vec3 l) { return max(0.0, (dot(n, l) + WRAP) / (1.0 + WRAP)); }
float through(vec3 n, vec3 l) { return max(0.0, -dot(n, l)); }
void main() {
  vec4 a = texture(uAlbedo, vUv);
  if (a.a < 0.002) discard;
  vec3 albedo = pow(a.rgb / a.a, vec3(2.2));
  vec3 n = normalize(texture(uNormal, vUv).rgb * 2.0 - 1.0);
  if (uMode == 1) { color = vec4((n * 0.5 + 0.5) * a.a, a.a); return; }
  if (uMode == 2) { color = vec4(a.rgb, a.a); return; }
  float map = uTranslucencyMap == 1 ? texture(uTranslucency, vUv).r : 1.0;
  if (uMode == 3) { color = vec4(vec3(map * uLayerTranslucency) * a.a, a.a); return; }
  float t = uLayerTranslucency * map;
  float f = uLayerFill;
  float sun = diffuse(n, uSunDir) + t * through(n, uSunDir) + f * diffuse(n, uSunFill);
  float moon = diffuse(n, uMoonDir) + t * through(n, uMoonDir) + f * diffuse(n, uMoonFill);
  float hemi = 0.75 + 0.25 * n.y;
  float edge = 1.0 - max(0.0, n.z);
  float rim = RIM * edge * edge * edge * max(0.0, -uSunDir.z) * max(0.0, uSunDir.y + 0.2);
  vec3 lit = albedo * (uAmbient * hemi + uSun * (sun + rim) + uMoon * moon);
  lit += (uHorizon * 0.8 - lit) * (uLayerHaze * uHaze);
  color = vec4(pow(max(lit, 0.0), vec3(1.0 / 2.2)) * a.a, a.a);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
uniform float uAlpha;
in vec2 vUv;
out vec4 color;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.35, 1.0, r)) * uAlpha;
  color = vec4(vec3(0.02, 0.04, 0.03) * a, a);
}`;

const STAR_VS = `#version 300 es
uniform vec2 uResolution;
in vec2 aPosition;
in vec2 aStar; // radius, alpha
out float vAlpha;
void main() {
  vAlpha = aStar.y;
  gl_PointSize = max(1.0, aStar.x * 2.0 + 1.0);
  gl_Position = vec4(aPosition / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const STAR_FS = `#version 300 es
precision highp float;
in float vAlpha;
out vec4 color;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.4, 1.0, r)) * vAlpha;
  color = vec4(vec3(0.95, 0.96, 1.0) * a, a);
}`;

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
    if (!(gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean))
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!(gl.getProgramParameter(program, gl.LINK_STATUS) as boolean))
    throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  return program;
}

function texture(
  gl: WebGL2RenderingContext,
  p: Pixels,
  premultiply: boolean,
): WebGLTexture {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    p.width,
    p.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    p.data,
  );
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

interface LayerTextures {
  size: Pixels;
  albedo: WebGLTexture;
  translucency: WebGLTexture | null;
  normals: Record<NormalSource, WebGLTexture | null>;
}

export interface Art {
  ridge: LayerArt;
  hill: LayerArt;
  sprites: LayerArt;
}

export interface Options {
  normals: NormalSource;
  /** Debugging: show the normal map or the flat albedo instead of lighting. */
  mode: "lit" | "normals" | "albedo" | "translucency";
  /** Use Codex translucency maps where a layer has one. */
  translucencyMap: boolean;
  adjust: Adjustments;
  inspect: boolean;
}

export class GpuTier {
  readonly #gl: WebGL2RenderingContext;
  readonly #sky: WebGLProgram;
  readonly #lit: WebGLProgram;
  readonly #shadow: WebGLProgram;
  readonly #star: WebGLProgram;
  readonly #buffer: WebGLBuffer;
  readonly #layers: Record<keyof Art, LayerTextures>;
  readonly #vao: WebGLVertexArrayObject;

  /** Null when WebGL2 is unavailable or would run in software. */
  static create(
    canvas: HTMLCanvasElement,
    art: Art,
    allowSoftware = false,
  ): GpuTier | null {
    const gl = canvas.getContext("webgl2", {
      failIfMajorPerformanceCaveat: !allowSoftware,
      powerPreference: "low-power",
      antialias: false,
      premultipliedAlpha: true,
      alpha: false,
    });
    return gl === null ? null : new GpuTier(gl, art);
  }

  private constructor(gl: WebGL2RenderingContext, art: Art) {
    this.#gl = gl;
    this.#sky = compile(gl, SKY_VS, SKY_FS);
    this.#lit = compile(gl, QUAD_VS, LIT_FS);
    this.#shadow = compile(gl, QUAD_VS, SHADOW_FS);
    this.#star = compile(gl, STAR_VS, STAR_FS);
    this.#buffer = gl.createBuffer();
    this.#vao = gl.createVertexArray();
    const upload = (layer: LayerArt): LayerTextures => ({
      size: layer.albedo,
      albedo: texture(gl, layer.albedo, true),
      translucency:
        layer.translucency === null
          ? null
          : texture(gl, layer.translucency, false),
      normals: {
        derived: texture(gl, layer.normals.derived, false),
        codex:
          layer.normals.codex === null
            ? null
            : texture(gl, layer.normals.codex, false),
      },
    });
    this.#layers = {
      ridge: upload(art.ridge),
      hill: upload(art.hill),
      sprites: upload(art.sprites),
    };
  }

  get renderer(): string {
    const gl = this.#gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info === null
      ? "WebGL2"
      : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  }

  #attributes(program: WebGLProgram, layout: [string, number][]): void {
    const gl = this.#gl;
    const stride = layout.reduce((sum, [, n]) => sum + n, 0) * 4;
    let offset = 0;
    for (const [name, size] of layout) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      offset += size * 4;
    }
  }

  #quads(
    program: WebGLProgram,
    quads: Quad[],
    texW: number,
    texH: number,
  ): number {
    const gl = this.#gl;
    const data = new Float32Array(quads.length * 6 * 4);
    let i = 0;
    for (const q of quads) {
      const u0 = q.sx / texW;
      const v0 = q.sy / texH;
      const u1 = (q.sx + q.sw) / texW;
      const v1 = (q.sy + q.sh) / texH;
      for (const [x, y, u, v] of [
        [q.x, q.y, u0, v0],
        [q.x + q.w, q.y, u1, v0],
        [q.x, q.y + q.h, u0, v1],
        [q.x, q.y + q.h, u0, v1],
        [q.x + q.w, q.y, u1, v0],
        [q.x + q.w, q.y + q.h, u1, v1],
      ] as const) {
        data.set([x, y, u, v], i);
        i += 4;
      }
    }
    gl.bindVertexArray(this.#vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    this.#attributes(program, [
      ["aPosition", 2],
      ["aUv", 2],
    ]);
    return quads.length * 6;
  }

  draw(state: LightingState, options: Options): void {
    const gl = this.#gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width;
    const H = canvas.height;
    const t = transform(W, H);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);

    // Sky.
    const sky = skyBodies(t, state);
    gl.useProgram(this.#sky);
    const su = (name: string) => gl.getUniformLocation(this.#sky, name);
    gl.uniform2f(su("uResolution"), W, H);
    gl.uniform3fv(su("uZenith"), state.sky.zenith);
    gl.uniform3fv(su("uHorizon"), state.sky.horizon);
    gl.uniform1f(su("uHorizonY"), sky.horizonY);
    gl.uniform4f(
      su("uSun"),
      sky.sun?.x ?? 0,
      sky.sun?.y ?? 0,
      sky.sun?.r ?? 1,
      sky.sun?.glow ?? 1,
    );
    gl.uniform4f(su("uSunColor"), ...state.sun.color, sky.sun?.alpha ?? 0);
    gl.uniform4f(
      su("uMoon"),
      sky.moon?.x ?? 0,
      sky.moon?.y ?? 0,
      sky.moon?.r ?? 1,
      sky.moon?.alpha ?? 0,
    );
    gl.uniform3fv(su("uMoonS"), sky.moon?.s ?? [0, 0, 1]);
    gl.uniform3fv(su("uMoonColor"), MOON_COLOR);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Stars.
    if (sky.stars.length > 0) {
      gl.useProgram(this.#star);
      gl.uniform2f(gl.getUniformLocation(this.#star, "uResolution"), W, H);
      const data = new Float32Array(
        sky.stars.flatMap((s) => [s.x, s.y, s.r, s.a]),
      );
      gl.bindVertexArray(this.#vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      this.#attributes(this.#star, [
        ["aPosition", 2],
        ["aStar", 2],
      ]);
      gl.drawArrays(gl.POINTS, 0, sky.stars.length);
    }

    // Lit layers and sprites.
    const p = lightParams(state, options.adjust);
    gl.useProgram(this.#lit);
    const lu = (name: string) => gl.getUniformLocation(this.#lit, name);
    gl.uniform2f(lu("uResolution"), W, H);
    gl.uniform3f(lu("uSunDir"), p.sunDir.x, p.sunDir.y, p.sunDir.z);
    gl.uniform3fv(lu("uSun"), p.sun);
    gl.uniform3f(lu("uMoonDir"), p.moonDir.x, p.moonDir.y, p.moonDir.z);
    gl.uniform3fv(lu("uMoon"), p.moon);
    gl.uniform3f(lu("uSunFill"), p.sunFill.x, p.sunFill.y, p.sunFill.z);
    gl.uniform3f(lu("uMoonFill"), p.moonFill.x, p.moonFill.y, p.moonFill.z);
    gl.uniform3fv(lu("uAmbient"), p.ambient);
    gl.uniform3fv(lu("uHorizon"), p.horizon);
    gl.uniform1f(lu("uHaze"), p.haze);
    gl.uniform1i(lu("uAlbedo"), 0);
    gl.uniform1i(lu("uNormal"), 1);
    gl.uniform1i(lu("uTranslucency"), 2);
    gl.uniform1i(
      lu("uMode"),
      ["lit", "normals", "albedo", "translucency"].indexOf(options.mode),
    );
    const drawLit = (
      layer: LayerTextures,
      quads: Quad[],
      light: LayerLight,
    ) => {
      gl.useProgram(this.#lit);
      gl.uniform1f(lu("uLayerHaze"), light.haze);
      // A map holds absolute translucency, replacing the layer's constant;
      // the slider scales either.
      const map = options.translucencyMap ? layer.translucency : null;
      gl.uniform1i(lu("uTranslucencyMap"), map === null ? 0 : 1);
      gl.uniform1f(
        lu("uLayerTranslucency"),
        (map === null ? light.translucency : 1) * p.translucency,
      );
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, map ?? layer.albedo);
      gl.uniform1f(lu("uLayerFill"), light.fill ? p.fill : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.albedo);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(
        gl.TEXTURE_2D,
        layer.normals[options.normals] ?? layer.normals.derived,
      );
      const count = this.#quads(
        this.#lit,
        quads,
        layer.size.width,
        layer.size.height,
      );
      gl.drawArrays(gl.TRIANGLES, 0, count);
    };
    const { ridge, hill, sprites } = this.#layers;
    drawLit(ridge, [layerQuad(t, ridge.size)], LAYERS.ridge);
    drawLit(hill, [layerQuad(t, hill.size)], LAYERS.hill);

    // Ground shadows, then the plants over them.
    const cast = shadows(t, state, options.inspect);
    if (cast.length > 0) {
      gl.useProgram(this.#shadow);
      gl.uniform2f(gl.getUniformLocation(this.#shadow, "uResolution"), W, H);
      gl.uniform1f(
        gl.getUniformLocation(this.#shadow, "uAlpha"),
        cast[0]?.alpha ?? 0,
      );
      const data: number[] = [];
      for (const s of cast) {
        const c = Math.cos(s.angle);
        const n = Math.sin(s.angle);
        const corner = (u: number, v: number) => {
          const lx = (u * 2 - 1) * s.rx;
          const ly = (v * 2 - 1) * s.ry;
          data.push(s.x + lx * c - ly * n, s.y + lx * n + ly * c, u, v);
        };
        corner(0, 0);
        corner(1, 0);
        corner(0, 1);
        corner(0, 1);
        corner(1, 0);
        corner(1, 1);
      }
      gl.bindVertexArray(this.#vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      this.#attributes(this.#shadow, [
        ["aPosition", 2],
        ["aUv", 2],
      ]);
      gl.drawArrays(gl.TRIANGLES, 0, cast.length * 6);
    }
    drawLit(
      sprites,
      spriteQuads(t, sprites.size, options.inspect),
      LAYERS.sprites,
    );
  }
}
