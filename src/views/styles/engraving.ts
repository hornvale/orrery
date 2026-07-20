import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../../sim/scene';
import type { RenderStyle } from '../renderStyle';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Note: variable names must avoid GLSL ES 3.00 (WebGL2) reserved words (`flat`,
// `sample`, `smooth`, `layout`, `patch`, …) — naming a variable one silently
// fails the whole shader compile (→ a black screen). None of the locals below
// collide (`luma`, `hatch`, `px`, `dir`, `ink`, `cream`, `sepia`, `src`, `l`).
const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uFreq;       // hatch line frequency (screen px)
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  // 1.0 where a hatch line at angle a is drawn, else 0.0
  float hatch(vec2 px, float a) {
    vec2 dir = vec2(cos(a), sin(a));
    float v = dot(px, dir) * uFreq;
    return step(0.5, fract(v)); // 1 on the "line" half, crude but crisp
  }
  void main() {
    vec4 src = texture2D(tDiffuse, vUv);
    // Cream paper, sepia ink.
    vec3 cream = vec3(0.93, 0.89, 0.78);
    vec3 sepia = vec3(0.18, 0.12, 0.08);
    // The composer delivers an OPAQUE frame: the globe's real colours where it
    // drew, opaque black where space is. Luminance-keyed hatching maps LOW
    // luminance to DENSE ink, and black space has luminance 0 — without this
    // early-out, space would hatch to solid sepia ink instead of staying paper.
    if (max(src.r, max(src.g, src.b)) < 0.02) {
      gl_FragColor = vec4(cream, 1.0);
      return;
    }
    float l = luma(src.rgb);
    vec2 px = vUv * uResolution;
    // Progressively add hatch directions as it gets darker.
    float ink = 0.0;
    if (l < 0.75) ink = max(ink, hatch(px, 0.6));
    if (l < 0.5)  ink = max(ink, hatch(px, -0.6));
    if (l < 0.28) ink = max(ink, hatch(px, 1.9));
    gl_FragColor = vec4(mix(cream, sepia, ink), 1.0);
  }
`;

export const engravingStyle: RenderStyle = {
  id: 'engraving',
  label: 'engraving',
  passes(_tiles: TilesScene): Pass[] {
    const pass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uFreq: { value: 0.12 },
      },
      vertexShader,
      fragmentShader,
    });
    // ShaderPass CLONES the uniforms, so capture the live `uResolution` AFTER
    // construction; the composer calls setSize with the drawing-buffer size.
    const uRes = pass.uniforms.uResolution!.value as THREE.Vector2;
    (pass as unknown as { setSize: (w: number, h: number) => void }).setSize = (w, h) => {
      uRes.set(w, h);
    };
    return [pass];
  },
};
