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

/** The screen-space period of one dither cell, in DEVICE pixels, at
 * `dotScale: 1`. The whole point of the technique is that this number does not
 * change with camera distance — `lvl` below is solved for it. */
export const DITHER_DOT_PX = 4;

/** The slice the fractional blend starts from. The blend spans exactly one
 * octave, `[BLEND_BASE, BLEND_BASE+1]`, and the two FINEST slices are the
 * right pair: slice 0 is a 1×1 Bayer, i.e. a CONSTANT 0.5, so blending
 * 0↔1 would make the pattern vanish entirely on every ring of the globe where
 * `lvl` happens to be an integer. */
const BLEND_BASE = Math.max(DITHER_LEVELS - 2, 0);

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
  //
  // max(), not min(): the COARSER axis sets the level, so a grazing or
  // skirt-like surface (one axis with almost no UV extent, hence almost no
  // derivative) never asks for a level finer than it can actually resolve.
  vec2 duv = vec2(length(dFdx(vDitherUv)), length(dFdy(vDitherUv)));
  float footprint = max(max(duv.x, duv.y), 1e-8);

  // The fractal level, solved so that one dither CELL covers exactly
  // uDotScale × DITHER_DOT_PX device pixels no matter how far away the
  // surface is. Its two halves do different jobs and must not double-count:
  //
  //   floor(lvl) -> the UV scale, exp2(floor(lvl)): which OCTAVE of the
  //                 pattern this pixel is on.
  //   fract(lvl) -> the slice blend: where between two adjacent Bayer orders
  //                 we sit WITHIN that octave.
  //
  // Slice k holds a 2^k Bayer, so cells-per-UV-unit is
  // exp2(floor(lvl)) · 2^(BASE+fract(lvl)) = exp2(lvl + BASE) — continuous
  // and monotone THROUGH each octave boundary, because the UV scale doubling
  // is exactly cancelled by dropping back one slice. Screen period is then
  // 1/(cells · footprint) = uDotScale · DITHER_DOT_PX, independent of
  // distance. (The earlier version drove the slice index from the ABSOLUTE
  // level as well as scaling the UV; the two multiplied, so the dots halved
  // at every octave and then froze surface-locked at the clamp.)
  //
  // The clamp is a float-precision guard, not a design limit: exp2(20) leaves
  // a UV product around 10^6, where fp32 still resolves a small fraction of a
  // cell. Screen-stability holds everywhere inside it.
  float lvl = clamp(-log2(footprint * uDotScale * DITHER_DOT_PX) - DITHER_BLEND_BASE, -6.0, 20.0);

  // Anisotropy: where the surface is stretched on screen, one dither cell
  // would otherwise come out rectangular. Cell period along x is
  // 1/(cells · bias · duv.x) and along y is 1/(cells · duv.y), so they are
  // equal exactly when bias = duv.y/duv.x. Applied to the x axis ALONE —
  // a scalar on both axes changes dot SIZE with grazing angle instead of
  // squaring the cell up, which is the opposite of compensating.
  float aniso = duv.y / max(duv.x, 1e-8);
  float bias = mix(1.0, clamp(aniso, 0.25, 4.0), uStretch);

  vec2 dotUv = vDitherUv * exp2(floor(lvl)) * vec2(bias, 1.0);
  // Half-texel centred: slice i's own texel centre is (i+0.5)/depth, so an
  // integer level lands exactly ON a slice rather than 83% of the way to it —
  // which is what preserves the centred normalization ditherTexture.ts built
  // the slices around.
  float sliceT = (DITHER_BLEND_BASE + fract(lvl) + 0.5) / DITHER_DEPTH;
  float threshold = texture(uDither, vec3(fract(dotUv), sliceT)).r;
  if (uInvert > 0.5) threshold = 1.0 - threshold;

  // Radial compensation: the perceived density falls off toward the screen
  // edge under a perspective projection; nudge the threshold back.
  // uViewport is the DRAWING BUFFER size, which is what gl_FragCoord counts
  // in — filling it from window.innerWidth put the "centre" at the quarter
  // point on a retina display and blew the frame out to white.
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

/** The uniform block the material owns. Exposed on `material.userData` so the
 * tests can read the plumbing without a GL context (happy-dom has no WebGL,
 * so nothing here compiles the GLSL — see this file's test). Writes go
 * through `setSettings`/`setViewport` below, never through `userData`. */
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
  /** The DRAWING BUFFER size in device pixels — `renderer.getDrawingBufferSize`,
   * never `window.innerWidth`. `gl_FragCoord` counts device pixels, so on a
   * DPR-2 display the CSS size puts the radial term's centre at the screen's
   * quarter point and drives `dot(ndc,ndc)` to 9, blowing the frame to white
   * across one diagonal. */
  setViewport(width: number, height: number): void;
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
         #define DITHER_DEPTH ${DITHER_LEVELS.toFixed(1)}
         #define DITHER_BLEND_BASE ${BLEND_BASE.toFixed(1)}
         #define DITHER_DOT_PX ${DITHER_DOT_PX.toFixed(1)}
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

  // Exposed for the tests only. `uViewport` is NOT refreshed per frame: it
  // changes only when the drawing buffer does, so `main.ts`'s `resize` (the
  // one place the renderer's real pixel ratio is in scope) drives it through
  // `globeView.setViewport` -> `setViewport` below, at boot and on resize.
  material.userData.ditherUniforms = uniforms;
  material.userData.ditherChunk = DITHER_CHUNK;

  return {
    material,
    setViewport(width, height) {
      uniforms.uViewport.value.set(Math.max(width, 1), Math.max(height, 1));
    },
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
