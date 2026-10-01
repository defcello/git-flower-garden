/**
 * The GPU tier's rain and snow (ADR 0018, "instanced particles"): one
 * instanced draw, each particle placed in the vertex shader by the same
 * formula as `particleAt` (weather-effects.ts), so the CPU does nothing per
 * particle and both tiers show the same fall.
 */
import {
  PARTICLE_LOOP_SECONDS,
  type ParticleField,
} from "../../environment/weather-effects.ts";
import { compile, CONTEXT, uniforms, type Uniforms } from "./gl.ts";
import type { GpuRenderer } from "./useGpu.ts";
import { transform } from "./view.ts";

const VS = `#version 300 es
uniform vec2 uResolution;
uniform vec3 uTransform;   // scale, ox, oy
uniform float uTime, uSpeed, uSlant, uSize;
uniform bool uSnow;
out vec2 vLocal;

float hash01(uint i, uint salt) {
  uint h = (i ^ (salt * 0x9e3779b1u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h ^= h >> 16u;
  return float(h) / 4294967296.0;
}

void main() {
  uint i = uint(gl_InstanceID);
  float H = 1080.0 + 120.0;
  float W = 1920.0 + 200.0;
  float speed = uSpeed * (0.8 + 0.4 * hash01(i, 3u));
  float fall = mod(hash01(i, 2u) * H + uTime * speed, H);
  float wobble = uSnow
    ? 14.0 * sin(uTime * (0.6 + hash01(i, 4u)) + hash01(i, 5u) * 6.283)
    : 0.0;
  float x = mod(hash01(i, 1u) * W + fall * uSlant + wobble, W) - 100.0;
  vec2 p = vec2(x, fall - 60.0);

  // A quad per particle: a streak along the fall for rain, a disc for snow.
  vec2 corner = vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : -1.0,
                     gl_VertexID >= 2 ? 1.0 : -1.0);
  vLocal = corner;
  vec2 offset;
  if (uSnow) {
    offset = corner * (uSize + 1.0);
  } else {
    vec2 along = normalize(vec2(uSlant, 1.0));
    vec2 across = vec2(along.y, -along.x);
    offset = along * corner.y * uSize * 0.5 + across * corner.x * 0.9;
  }
  vec2 canvas = uTransform.yz + (p + offset) * uTransform.x;
  gl_Position = vec4(canvas / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec4 uColor; // rgb, alpha
uniform bool uSnow;
in vec2 vLocal;
out vec4 color;
void main() {
  float a;
  if (uSnow) {
    a = clamp(1.0 - length(vLocal), 0.0, 1.0);
    a = a * a * (3.0 - 2.0 * a);
  } else {
    // Brightest mid-streak, fading at both ends and across.
    a = (1.0 - abs(vLocal.y)) * (1.0 - abs(vLocal.x));
  }
  a *= uColor.a;
  if (a <= 0.0) discard;
  color = vec4(uColor.rgb * a, a);
}`;

export class PrecipitationGpu implements GpuRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #u: Uniforms;
  readonly #vao: WebGLVertexArrayObject;
  readonly renderer = "precipitation";

  static readonly create = (
    canvas: HTMLCanvasElement,
  ): PrecipitationGpu | null => {
    const gl = canvas.getContext("webgl2", CONTEXT);
    return gl === null || gl.isContextLost() ? null : new PrecipitationGpu(gl);
  };

  private constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#program = compile(gl, VS, FS);
    this.#u = uniforms(gl, this.#program, [
      "uResolution",
      "uTransform",
      "uTime",
      "uSpeed",
      "uSlant",
      "uSize",
      "uSnow",
      "uColor",
    ]);
    this.#vao = gl.createVertexArray();
  }

  /** Nothing to load: the particles are computed. */
  load(): Promise<void> {
    return Promise.resolve();
  }

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

  /** Clear, then draw `field` at `seconds` (null: nothing falls). */
  draw(field: ParticleField | null, seconds: number): void {
    const gl = this.#gl;
    if (gl.isContextLost()) return;
    const canvas = gl.canvas as HTMLCanvasElement;
    const W = canvas.width;
    const H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (field === null) return;
    const t = transform(W, H);
    const u = this.#u;
    gl.useProgram(this.#program);
    gl.bindVertexArray(this.#vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(u.uResolution ?? null, W, H);
    gl.uniform3f(u.uTransform ?? null, t.scale, t.ox, t.oy);
    gl.uniform1f(u.uTime ?? null, seconds % PARTICLE_LOOP_SECONDS);
    gl.uniform1f(u.uSpeed ?? null, field.speed);
    gl.uniform1f(u.uSlant ?? null, field.slant);
    gl.uniform1f(u.uSize ?? null, field.size);
    gl.uniform1i(u.uSnow ?? null, field.type === "rain" ? 0 : 1);
    gl.uniform4f(u.uColor ?? null, ...field.color, field.alpha);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, field.count);
  }
}
