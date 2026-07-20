import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../../sim/scene';
import type { RenderStyle } from '../renderStyle';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Note: variable names must avoid GLSL ES 3.00 (WebGL2) reserved words (flat,
// sample, smooth, layout, patch, ...) - naming a variable one silently fails
// the whole shader compile (-> a black screen). None of the locals below
// collide (quad, lo, hi, mean, varSum, bestM, bestV, quads, pool, washed).
const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;    // 1/resolution
  uniform float uRadius;  // sample radius in px
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  // Mean + variance of one quadrant.
  void quad(vec2 lo, vec2 hi, out vec3 mean, out float varSum) {
    vec3 sum = vec3(0.0); vec3 sum2 = vec3(0.0); float n = 0.0;
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
      vec2 o = mix(lo, hi, vec2(float(x), float(y)) / 3.0);
      vec3 c = texture2D(tDiffuse, vUv + o * uTexel).rgb;
      sum += c; sum2 += c * c; n += 1.0;
    }
    mean = sum / n;
    vec3 v = sum2 / n - mean * mean;
    varSum = v.r + v.g + v.b;
  }
  void main() {
    float r = uRadius;
    vec3 m; float v; vec3 bestM; float bestV = 1e9;
    vec2 quads[4];
    quads[0] = vec2(-r, -r); quads[1] = vec2(0.0, -r); quads[2] = vec2(-r, 0.0); quads[3] = vec2(0.0, 0.0);
    for (int i = 0; i < 4; i++) {
      vec2 lo = quads[i]; vec2 hi = lo + vec2(r, r);
      quad(lo, hi, m, v);
      if (v < bestV) { bestV = v; bestM = m; }
    }
    // Pigment pools a touch at busy boundaries (high overall variance).
    float pool = clamp(bestV * 6.0, 0.0, 0.25);
    vec3 washed = bestM * (1.0 - pool);
    // Procedural paper grain.
    float g = fract(sin(dot(vUv * 700.0, vec2(12.9898, 78.233))) * 43758.5453);
    washed *= 0.94 + 0.06 * g;
    // Force opaque output: the composer's frame is already opaque (real
    // colours where the globe drew, opaque black for space), so preserving
    // the source alpha isn't needed and forcing 1.0 keeps compositing simple.
    gl_FragColor = vec4(washed, 1.0);
  }
`;

export const watercolorStyle: RenderStyle = {
  id: 'watercolor',
  label: 'watercolor',
  passes(_tiles: TilesScene): Pass[] {
    const pass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uRadius: { value: 3.0 },
      },
      vertexShader,
      fragmentShader,
    });
    // ShaderPass CLONES the uniforms, so capture the live `uTexel` AFTER
    // construction; the composer calls setSize with the drawing-buffer size.
    const uTexel = pass.uniforms.uTexel!.value as THREE.Vector2;
    (pass as unknown as { setSize: (w: number, h: number) => void }).setSize = (w, h) => {
      uTexel.set(1 / w, 1 / h);
    };
    return [pass];
  },
};
