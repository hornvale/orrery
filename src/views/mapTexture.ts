/** The flat "map" rung's crisp pixel-art region texture: builds a curated
 * biome/ocean palette texture straight from a `RegionScene`'s per-node
 * arrays. Flat plane, no sphere distortion, so pixel-art reads cleanly here
 * (unlike the globe, which needs a smoother base). The pixel math
 * (`regionPixelRGBA`) is split from the `THREE.DataTexture` wrapper
 * (`regionPixelTexture`), same split as `./moonTexture.ts`, so it is
 * unit-testable without constructing a three.js texture. */
import * as THREE from 'three';
import type { RegionScene } from '../sim/scene';
import { pixelColorFor } from './styles/pixelBase';
import { overworldRGBA, OVERWORLD_TEXTURE_DIM } from './styles/overworld';

/** RGBA bytes (4 per node, row-major, length 4·(samples+1)²) for `region`,
 * each node coloured by the curated flat pixel palette. Pure — no GPU. */
export function regionPixelRGBA(region: RegionScene): Uint8Array {
  const dim = region.samples + 1;
  const count = dim * dim;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    // pixelColorFor's first arg is a fallback RGB for nodes with no biome
    // datum; regions always carry biome, so [0,0,0] is never reached.
    const [r, g, b] = pixelColorFor([0, 0, 0], region, i);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A crisp (NearestFilter) pixel texture of `region`'s biome/ocean, for the
 * flat map rung. */
export function regionPixelTexture(region: RegionScene): THREE.DataTexture {
  const dim = region.samples + 1;
  const tex = new THREE.DataTexture(regionPixelRGBA(region), dim, dim, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  // `regionPixelRGBA` is row-major top-down (row 0 = grid gy=0), and the
  // symbol overlay (`mapSymbols` `gridToWorld`) places gy=0 at the quad's TOP.
  // DataTexture's default `flipY:false` would draw row 0 at the BOTTOM, mirroring
  // the base against the symbols. Flip so both agree — symbols land on their terrain.
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

/** The procedural 16-bit-RPG-style overworld texture (campaign "The
 * Overworld"): a higher-resolution replacement for `regionPixelTexture`,
 * built from `overworldRGBA` at `OVERWORLD_TEXTURE_DIM`. Same wrapper shape
 * as `regionPixelTexture` (crisp `NearestFilter`, `flipY:true` so the base
 * agrees with the symbol overlay) — only the pixel source differs. */
export function overworldTexture(region: RegionScene): THREE.DataTexture {
  const dim = OVERWORLD_TEXTURE_DIM;
  const tex = new THREE.DataTexture(overworldRGBA(region, dim), dim, dim, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  // Same rationale as `regionPixelTexture`'s flip: row 0 of `overworldRGBA`
  // is region gy=0, and the symbol overlay expects gy=0 at the quad's top.
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}
