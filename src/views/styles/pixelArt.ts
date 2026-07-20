import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../../sim/scene';
import type { RenderStyle } from '../renderStyle';
import { biomeColorForName } from '../biomePalette';

const MAX_COLORS = 16;

/** Up to 16 RGB triples (0..1) for this world's dominant biomes, ordered by
 * cell frequency (most common first). Deterministic: a pure function of the
 * tiles' biome layer. Each seed gets its own palette.
 *
 * `tiles.biome` holds indices into `tiles.biomeLegend` (the per-world biome
 * catalog, see `sim/scene.ts`); `biomeColorForName` keys by the legend NAME,
 * not the numeric index, so each index is resolved through the legend first.
 * A missing/out-of-range legend entry resolves to the empty string, which
 * `biomeColorForName` maps to its own defensive grey fallback. */
export function biomePalette(tiles: TilesScene): [number, number, number][] {
  const biome = tiles.biome as unknown as ArrayLike<number>;
  const legend = tiles.biomeLegend as unknown as ArrayLike<string> | undefined;
  const counts = new Map<number, number>();
  for (let i = 0; i < biome.length; i++) {
    const b = biome[i]!;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out: [number, number, number][] = [];
  for (const [b] of ordered.slice(0, MAX_COLORS)) {
    const name = legend?.[b] ?? '';
    const rgb = biomeColorForName(name); // [0..255]
    out.push([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]);
  }
  return out;
}

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;   // canvas px
  uniform float uPixelSize;   // px per art-pixel
  uniform vec3 uPalette[16];
  uniform int uPaletteLen;
  varying vec2 vUv;
  void main() {
    // Snap UV to a coarse grid (the "pixels").
    vec2 grid = uResolution / uPixelSize;
    vec2 snapped = (floor(vUv * grid) + 0.5) / grid;
    vec4 src = texture2D(tDiffuse, snapped);
    // Nearest palette colour.
    float best = 1e9; vec3 pick = src.rgb;
    for (int i = 0; i < 16; i++) {
      if (i >= uPaletteLen) break;
      float d = distance(src.rgb, uPalette[i]);
      if (d < best) { best = d; pick = uPalette[i]; }
    }
    // Force opaque output: the composer's intermediate target does not carry a
    // reliable alpha where the globe drew, so preserving src.a rendered the whole
    // frame transparent (the page background showed through). Keep the near-black
    // space background black rather than snapping it to a biome colour.
    if (max(src.r, max(src.g, src.b)) < 0.02) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
      gl_FragColor = vec4(pick, 1.0);
    }
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export const pixelArtStyle: RenderStyle = {
  id: 'pixel-art',
  label: 'pixel-art',
  passes(tiles: TilesScene): Pass[] {
    const palette = biomePalette(tiles);
    const flat = new Array(16).fill(0).map((_, i) => new THREE.Vector3(...(palette[i] ?? palette[palette.length - 1] ?? [0, 0, 0])));
    const pass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPixelSize: { value: 4.0 },
        uPalette: { value: flat },
        uPaletteLen: { value: Math.max(1, palette.length) },
      },
      vertexShader,
      fragmentShader,
    });
    // ShaderPass CLONES the uniforms above, so the live uniform the shader reads
    // is `pass.uniforms.uResolution` — NOT the object literal we passed in.
    // Capture it AFTER construction; the composer calls this setSize (via
    // EffectComposer.addPass/setSize) with the drawing-buffer dimensions.
    const uRes = pass.uniforms.uResolution!.value as THREE.Vector2;
    (pass as unknown as { setSize: (w: number, h: number) => void }).setSize = (w, h) => {
      uRes.set(w, h);
    };
    return [pass];
  },
};
