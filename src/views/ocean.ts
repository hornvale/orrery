/** The ocean layer: a smooth, translucent sea-level sphere over the
 * displaced seafloor (spec: docs/superpowers/specs/2026-07-15-watery-oceans-design.md).
 * Same split as the other views: pure grading/radius math (unit-tested
 * directly), then the three.js builder that consumes it. */
import * as THREE from 'three';
import type { TilesScene } from '../sim/scene';
import { REFERENCE_RADIUS_M } from './worldMesh';
import { TILE_QUADS, tileGrid } from './cubeSphere';
import { sampleTile } from './worldMesh';

/** Depth (m below sea level) at which water reaches full darkness/opacity. */
export const DEEP_FULL_M = 3000;
/** Water alpha over the shallowest ocean (seafloor clearly visible). */
export const SHALLOW_ALPHA = 0.35;
/** Water alpha at DEEP_FULL_M and beyond (nearly opaque). */
export const DEEP_ALPHA = 0.92;
/** Shallow-water tint (0-1 channels) — a tuning knob, not a contract. */
export const SHALLOW_COLOR: [number, number, number] = [0.55, 0.8, 0.85];
/** Deep-water tint (0-1 channels) — a tuning knob, not a contract. */
export const DEEP_COLOR: [number, number, number] = [0.02, 0.15, 0.3];

/** The sea sphere's radius: exactly where `buildFaceGeometry` puts sea level
 * for this `reliefScale` (sea_level_m is datum-relative and negative in
 * practice, so this sits below the undisplaced radius). */
export function seaLevelRadius(tiles: TilesScene, radius: number, reliefScale: number): number {
  return radius * (1 + (reliefScale * tiles.sea_level_m) / REFERENCE_RADIUS_M);
}

/** Depth-graded water: pale, translucent aqua over the shallows smoothing to
 * near-opaque dark blue by DEEP_FULL_M. Callers gate land to alpha 0 with the
 * tile's own `ocean` flag — depth alone can't tell coastal land (elevation at
 * exactly sea level) from zero-depth sea. */
export function waterColorAlpha(depthM: number): { r: number; g: number; b: number; a: number } {
  const t = Math.min(1, Math.max(0, depthM / DEEP_FULL_M));
  const s = t * t * (3 - 2 * t); // smoothstep
  const lerp = (from: number, to: number) => from + (to - from) * s;
  return {
    r: lerp(SHALLOW_COLOR[0], DEEP_COLOR[0]),
    g: lerp(SHALLOW_COLOR[1], DEEP_COLOR[1]),
    b: lerp(SHALLOW_COLOR[2], DEEP_COLOR[2]),
    a: lerp(SHALLOW_ALPHA, DEEP_ALPHA),
  };
}

/** One cube face of the sea: a smooth sphere at `seaLevelRadius`, RGBA
 * vertex colors carrying the depth grading (alpha 0 over land, so continents
 * punch through with a soft coastline). Normals are the unit position
 * directions — exact for a sphere, and identical across face edges by
 * construction, so no seam stitching is needed. Returns null when the whole
 * face is land (no mesh at all beats an invisible one). */
export function buildOceanGeometry(
  tiles: TilesScene,
  face: number,
  radius: number,
  reliefScale: number,
): THREE.BufferGeometry | null {
  const grid = tileGrid({ face, level: 0, ix: 0, iy: 0 });
  const n = TILE_QUADS + 1;
  const r = seaLevelRadius(tiles, radius, reliefScale);
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 4);
  let hasOcean = false;
  for (let i = 0; i < n * n; i++) {
    const ux = grid.units[3 * i]!;
    const uy = grid.units[3 * i + 1]!;
    const uz = grid.units[3 * i + 2]!;
    positions[3 * i] = ux * r;
    positions[3 * i + 1] = uy * r;
    positions[3 * i + 2] = uz * r;
    normals[3 * i] = ux;
    normals[3 * i + 1] = uy;
    normals[3 * i + 2] = uz;
    const lat = grid.lats[i]!;
    const lon = grid.lons[i]!;
    const ocean = sampleTile(tiles, lat, lon, 'ocean');
    const water = waterColorAlpha(tiles.sea_level_m - sampleTile(tiles, lat, lon, 'elevation_m'));
    colors[4 * i] = water.r;
    colors[4 * i + 1] = water.g;
    colors[4 * i + 2] = water.b;
    colors[4 * i + 3] = ocean ? water.a : 0;
    if (ocean) hasOcean = true;
  }
  if (!hasOcean) return null;
  const indices: number[] = [];
  for (let row = 0; row < TILE_QUADS; row++) {
    for (let col = 0; col < TILE_QUADS; col++) {
      const i00 = row * n + col;
      const i10 = row * n + col + 1;
      const i01 = (row + 1) * n + col;
      const i11 = (row + 1) * n + col + 1;
      // Same CCW winding as worldMesh's buildFaceGeometry — outward-facing
      // on every face without a per-face special case.
      indices.push(i00, i10, i11, i00, i11, i01);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geom.setIndex(indices);
  return geom;
}
