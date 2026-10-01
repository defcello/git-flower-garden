/**
 * What the GPU tier's renderers share (ADR 0018, step 4): compiling
 * programs, uploading textures, the scene's maps, and `SHADE_GLSL`, the
 * shader copy of `shade` (shading.ts), kept in one place so the landscape
 * and the plants cannot drift from it or from each other.
 */
import hillAlbedo from "../assets/scene/hill-albedo.png";
import hillNormal from "../assets/scene/hill-normal.png";
import hillTranslucency from "../assets/scene/hill-translucency.png";
import ridgeAlbedo from "../assets/scene/ridge-albedo.png";
import ridgeNormal from "../assets/scene/ridge-normal.png";
import spritesAlbedo from "../assets/scene/sprites-albedo.png";
import spritesNormal from "../assets/scene/sprites-normal.png";
import spritesTranslucency from "../assets/scene/sprites-translucency.png";
import { RIM_GAIN, WRAP, type LightParams } from "./shading.ts";

/** Options for the GPU tier's contexts (ADR 0018, "Choosing a tier"). */
export const CONTEXT: WebGLContextAttributes = {
  powerPreference: "low-power",
  antialias: false,
  premultipliedAlpha: true,
  // Frames are drawn only when something changes, so the last one must
  // survive compositing (and can be read back by tests).
  preserveDrawingBuffer: true,
};

/**
 * `shade` (shading.ts) in GLSL, with relight.ts's map decoding: the light
 * uniforms, and `shadeTexel`, which lights one texel of a layer or sprite.
 */
export const SHADE_GLSL = `
uniform vec3 uSunDir, uSun, uMoonDir, uMoon, uSunFill, uMoonFill, uAmbient, uHorizon;
uniform float uHaze, uTranslucencyScale, uFillScale;
const float WRAP = ${WRAP.toFixed(6)};
const float RIM_GAIN = ${RIM_GAIN.toFixed(6)};
float diffuse(vec3 n, vec3 l) { return max(0.0, (dot(n, l) + WRAP) / (1.0 + WRAP)); }
float through(vec3 n, vec3 l) { return max(0.0, -dot(n, l)); }
// Light for a unit normal n: translucency 0..1, fill 0 or 1, haze 0..1.
vec3 shadeLinear(vec3 albedo, vec3 n, float translucency, float fill, float layerHaze) {
  float t = translucency * uTranslucencyScale;
  float f = fill * uFillScale;
  float sun = diffuse(n, uSunDir) + t * through(n, uSunDir) + f * diffuse(n, uSunFill);
  float moon = diffuse(n, uMoonDir) + t * through(n, uMoonDir) + f * diffuse(n, uMoonFill);
  // Sky light from above, a little less on faces turned down.
  float hemi = 0.75 + 0.25 * n.y;
  // Backlight catches silhouettes when the light is behind the scene.
  float edge = 1.0 - max(0.0, n.z);
  float rim = RIM_GAIN * edge * edge * edge * max(0.0, -uSunDir.z) * max(0.0, uSunDir.y + 0.2);
  vec3 lit = albedo * (uAmbient * hemi + uSun * (sun + rim) + uMoon * moon);
  float h = layerHaze * uHaze;
  return lit + (uHorizon * 0.8 - lit) * h;
}
// A premultiplied albedo texel and its encoded normal, lit; premultiplied
// sRGB out. Alpha is snapped at both ends as cleanAlpha does. Returns
// alpha 0 for texels to discard.
vec4 shadeTexel(vec4 a, vec3 encodedNormal, bool flipX, float translucency,
                float fill, float layerHaze) {
  if (a.a < 8.0 / 255.0) return vec4(0.0);
  float alpha = a.a >= 240.0 / 255.0 ? 1.0 : a.a;
  vec3 albedo = pow(a.rgb / a.a, vec3(2.2));
  vec3 n = encodedNormal * 2.0 - 1.0;
  if (flipX) n.x = -n.x;
  n = normalize(n);
  vec3 lit = shadeLinear(albedo, n, translucency, fill, layerHaze);
  return vec4(pow(clamp(lit, 0.0, 1.0), vec3(1.0 / 2.2)) * alpha, alpha);
}
float luminance(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

export const LIGHT_UNIFORMS = [
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
  "uFillScale",
] as const;

export type Uniforms = Record<string, WebGLUniformLocation | null>;

export function uniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly string[],
): Uniforms {
  return Object.fromEntries(
    names.map((name) => [name, gl.getUniformLocation(program, name)]),
  );
}

/** Set `SHADE_GLSL`'s light uniforms on the current program. */
export function setLight(
  gl: WebGL2RenderingContext,
  u: Uniforms,
  p: LightParams,
): void {
  gl.uniform3f(u.uSunDir ?? null, p.sunDir.x, p.sunDir.y, p.sunDir.z);
  gl.uniform3fv(u.uSun ?? null, p.sun);
  gl.uniform3f(u.uMoonDir ?? null, p.moonDir.x, p.moonDir.y, p.moonDir.z);
  gl.uniform3fv(u.uMoon ?? null, p.moon);
  gl.uniform3f(u.uSunFill ?? null, p.sunFill.x, p.sunFill.y, p.sunFill.z);
  gl.uniform3f(u.uMoonFill ?? null, p.moonFill.x, p.moonFill.y, p.moonFill.z);
  gl.uniform3fv(u.uAmbient ?? null, p.ambient);
  gl.uniform3fv(u.uHorizon ?? null, p.horizon);
  gl.uniform1f(u.uHaze ?? null, p.haze);
  gl.uniform1f(u.uTranslucencyScale ?? null, p.translucency);
  gl.uniform1f(u.uFillScale ?? null, p.fill);
}

export function compile(
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

/**
 * Uploads bind on this unit, which no program samples: binding on the
 * active unit would swap out whatever a draw had bound there.
 */
const UPLOAD_UNIT = 7;

/** A mipmapped texture from a decoded map (see `loadMaps` on premultiplying). */
export function uploadMap(
  gl: WebGL2RenderingContext,
  image: ImageBitmap,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
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

/**
 * Upload a canvas drawn at the size it is shown, premultiplied, into
 * `texture` (made when null). No mipmaps: it is drawn one to one.
 */
export function uploadCanvas(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  texture: WebGLTexture | null,
): WebGLTexture {
  const t = texture ?? gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function rendererName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info === null
    ? String(gl.getParameter(gl.RENDERER))
    : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
}

export interface LayerMaps {
  albedo: ImageBitmap;
  normal: ImageBitmap;
  translucency: ImageBitmap | null;
}

export interface Maps {
  ridge: LayerMaps;
  hill: LayerMaps;
  sprites: LayerMaps;
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

/** The scene's maps, decoded once per page and kept across lost contexts. */
export function loadMaps(): Promise<Maps> {
  maps ??= Promise.all([
    bitmap(ridgeAlbedo, true),
    bitmap(ridgeNormal, false),
    bitmap(hillAlbedo, true),
    bitmap(hillNormal, false),
    bitmap(hillTranslucency, false),
    bitmap(spritesAlbedo, true),
    bitmap(spritesNormal, false),
    bitmap(spritesTranslucency, false),
  ]).then(([ra, rn, ha, hn, ht, sa, sn, st]) => ({
    ridge: { albedo: ra, normal: rn, translucency: null },
    hill: { albedo: ha, normal: hn, translucency: ht },
    sprites: { albedo: sa, normal: sn, translucency: st },
  }));
  maps.catch(() => {
    maps = null;
  });
  return maps;
}

/** Canvas pixels to clip space, for vertex shaders. */
export const TO_CLIP_GLSL = `
vec4 toClip(vec2 p, vec2 resolution) {
  return vec4(p / resolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}
`;
