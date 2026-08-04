/** Surface-Stable Fractal Dithering as a MATERIAL, not a post-process.
 *
 * Every other skin this app has had was an EffectComposer pass over the
 * finished frame. This one cannot be: the dots stick to the SURFACE, which
 * means the shader needs the surface's own UV and its screen-space
 * derivatives. That is the entire reason `worldMesh` grew a face-space `uv`
 * attribute.
 *
 * The injection lands AFTER lighting, so it quantizes the LIT colour. That is
 * what preserves the honest terminator (spec §4½): the terminator's falloff
 * becomes the dot-density gradient rather than being flattened away.
 *
 * GLSL ES 3.00 reserved words (`flat`, `sample`, `smooth`, `layout`, `patch`,
 * `filter`, `input`) must never name a variable — a collision silently fails
 * the whole compile and blacks the screen. Locals below are deliberately
 * named around that: `lum`, `dotUv`, `ink`, `lvl`, `tone`, `bias`.
 *
 * three (r163+) compiles every material as `#version 300 es` even under its
 * WebGL2-only renderer, prefixing `#define varying in/out` and
 * `#define gl_FragColor pc_fragColor`. So the chunk below may write
 * `varying`/`gl_FragColor` in three's own dialect while still using the
 * GLSL3-only `texture(sampler3D, …)` overload. */
import * as THREE from 'three';
import { DITHER_LEVELS, createDitherTexture } from './ditherTexture';

export interface DitherSettings {
  /** Colour keeps the lens readable; grayscale is the stronger image and
   * makes five of the seven lenses indistinguishable. Colour is the default
   * for that reason — see the Console spec §4. */
  colourMode: 'colour' | 'grayscale';
  dotScale: number;
  contrast: number;
  /** 0 = Bayer-style (vary the dot COUNT), 1 = halftone-style (vary the dot SIZE). */
  variability: number;
  /** Anisotropic smoothing where the surface is stretched relative to screen. */
  stretch: number;
  invert: boolean;
  radialCompensation: boolean;
}

export const DITHER_DEFAULTS: DitherSettings = {
  colourMode: 'colour',
  dotScale: 1,
  contrast: 1,
  variability: 0,
  stretch: 0.5,
  invert: false,
  radialCompensation: true,
};

const DITHER_CHUNK = /* glsl */ `
  // Screen-space footprint of one UV unit — the derivative that makes the
  // dots surface-stable: as the surface nears the camera this shrinks, the
  // level index rises, and the pattern subdivides into MORE dots rather
  // than bigger ones.
  vec2 duv = vec2(length(dFdx(vDitherUv)), length(dFdy(vDitherUv)));
  float footprint = max(max(duv.x, duv.y), 1e-8);
  // Which fractal level this pixel sits at. log2 of the footprint, so a
  // doubling of distance steps exactly one slice.
  float lvl = clamp(-log2(footprint * uDotScale), 0.0, float(DITHER_LEVELS_C) - 1.0);
  float sliceT = lvl / max(float(DITHER_LEVELS_C) - 1.0, 1.0);

  // Anisotropy: where the surface is stretched (a grazing angle), soften
  // along the stretched axis so dots smear rather than alias.
  float aniso = duv.x / max(duv.y, 1e-8);
  float bias = mix(1.0, clamp(aniso, 0.25, 4.0), uStretch);

  vec2 dotUv = vDitherUv * exp2(floor(lvl)) * bias;
  float threshold = texture(uDither, vec3(fract(dotUv), sliceT)).r;
  if (uInvert > 0.5) threshold = 1.0 - threshold;

  // Radial compensation: the perceived density falls off toward the screen
  // edge under a perspective projection; nudge the threshold back.
  if (uRadial > 0.5) {
    vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
    threshold -= 0.06 * dot(ndc, ndc);
  }

  vec3 tone = gl_FragColor.rgb;
  float lum = dot(tone, vec3(0.299, 0.587, 0.114));
  float ink;
  if (uGrayscale > 0.5) {
    ink = clamp((lum - 0.5) * uContrast + 0.5, 0.0, 1.0);
    // uVariability blends dot-COUNT shading (hard step) toward dot-SIZE
    // shading (a soft ramp around the threshold).
    float hard = step(threshold, ink);
    float soft = smoothstep(threshold - 0.25, threshold + 0.25, ink);
    gl_FragColor.rgb = vec3(mix(hard, soft, uVariability));
  } else {
    // Per-channel against the SAME threshold, so hue survives and the lens
    // stays readable. Two levels per channel is the palette collapse this
    // look is for.
    vec3 c = clamp((tone - 0.5) * uContrast + 0.5, 0.0, 1.0);
    vec3 hard = step(vec3(threshold), c);
    vec3 soft = smoothstep(vec3(threshold - 0.25), vec3(threshold + 0.25), c);
    gl_FragColor.rgb = mix(hard, soft, uVariability);
  }
`;

/** The uniform block the material owns. Exposed on `material.userData` so
 * `globe.ts` can keep `uViewport` current per frame and the tests can read the
 * plumbing without a GL context (happy-dom has no WebGL, so nothing here
 * compiles the GLSL — see this file's test). */
export interface DitherUniforms {
  uDither: { value: THREE.Data3DTexture };
  uDotScale: { value: number };
  uContrast: { value: number };
  uVariability: { value: number };
  uStretch: { value: number };
  uInvert: { value: number };
  uRadial: { value: number };
  uGrayscale: { value: number };
  uViewport: { value: THREE.Vector2 };
}

export function createDitherMaterial(): {
  material: THREE.MeshStandardMaterial;
  setSettings(s: Partial<DitherSettings>): void;
} {
  const uniforms: DitherUniforms = {
    uDither: { value: createDitherTexture() },
    uDotScale: { value: DITHER_DEFAULTS.dotScale },
    uContrast: { value: DITHER_DEFAULTS.contrast },
    uVariability: { value: DITHER_DEFAULTS.variability },
    uStretch: { value: DITHER_DEFAULTS.stretch },
    uInvert: { value: DITHER_DEFAULTS.invert ? 1 : 0 },
    uRadial: { value: DITHER_DEFAULTS.radialCompensation ? 1 : 0 },
    uGrayscale: { value: DITHER_DEFAULTS.colourMode === 'grayscale' ? 1 : 0 },
    uViewport: { value: new THREE.Vector2(1, 1) },
  };

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDitherUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDitherUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         #define DITHER_LEVELS_C ${DITHER_LEVELS}
         precision highp sampler3D;
         uniform sampler3D uDither;
         uniform float uDotScale, uContrast, uVariability, uStretch, uInvert, uRadial, uGrayscale;
         uniform vec2 uViewport;
         varying vec2 vDitherUv;`,
      )
      // AFTER lighting and tonemapping: quantize the LIT colour, so the
      // terminator's falloff becomes the dot-density gradient.
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${DITHER_CHUNK}`);
  };
  // Force a recompile the first time this material is used, since
  // onBeforeCompile was assigned after construction.
  material.needsUpdate = true;

  // Exposed for the tests and for `globe.ts`'s per-frame viewport update.
  material.userData.ditherUniforms = uniforms;
  material.userData.ditherChunk = DITHER_CHUNK;

  return {
    material,
    setSettings(s) {
      if (s.colourMode !== undefined) uniforms.uGrayscale.value = s.colourMode === 'grayscale' ? 1 : 0;
      if (s.dotScale !== undefined) uniforms.uDotScale.value = s.dotScale;
      if (s.contrast !== undefined) uniforms.uContrast.value = s.contrast;
      if (s.variability !== undefined) uniforms.uVariability.value = s.variability;
      if (s.stretch !== undefined) uniforms.uStretch.value = s.stretch;
      if (s.invert !== undefined) uniforms.uInvert.value = s.invert ? 1 : 0;
      if (s.radialCompensation !== undefined) uniforms.uRadial.value = s.radialCompensation ? 1 : 0;
    },
  };
}
