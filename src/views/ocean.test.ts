import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEEP_ALPHA,
  DEEP_FULL_M,
  SHALLOW_ALPHA,
  seaLevelRadius,
  waterColorAlpha,
  buildOceanGeometry,
  createOcean,
  waveOffset,
} from './ocean';
import { REFERENCE_RADIUS_M } from './worldMesh';
import { TILE_QUADS } from './cubeSphere';
import type { TilesScene } from '../sim/scene';

/** 4×2 world, west half ocean (100 m deep), east half land 500 m above sea.
 * sea_level_m is deliberately non-zero: the datum's zero is not sea level. */
export function oceanTiles(): TilesScene {
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: -2500,
    // row-major, row 0 = north: cols 0-1 ocean floor, cols 2-3 land.
    elevation_m: [-2600, -2600, -2000, -2000, -2600, -2600, -2000, -2000],
    ocean: [true, true, false, false, true, true, false, false],
    biome: [0, 0, 0, 0, 0, 0, 0, 0], biomeLegend: ['steppe'], features: [],
    t_mean_c: Array(8).fill(15), t_swing_c: Array(8).fill(5), tDiurnalAmpC: Array(8).fill(8),
    currentEast: Array(8).fill(0), currentNorth: Array(8).fill(0),
    season_period_days: 365, circulationBands: null, moisture: Array(8).fill(0.5),
    plate: Array(8).fill(0), unrest: Array(8).fill(0), locked: false,
    precipMmYr: Array(8).fill(800), snowFraction: Array(8).fill(0.1),
    precipRegime: Array(8).fill(0), cloudFraction: Array(8).fill(0.4),
  };
}

describe('seaLevelRadius', () => {
  it('is where buildFaceGeometry puts sea level, in both relief modes', () => {
    const tiles = oceanTiles();
    expect(seaLevelRadius(tiles, 2, 60)).toBeCloseTo(2 * (1 + (60 * -2500) / REFERENCE_RADIUS_M), 12);
    expect(seaLevelRadius(tiles, 2, 1)).toBeCloseTo(2 * (1 + (1 * -2500) / REFERENCE_RADIUS_M), 12);
  });
});

describe('waterColorAlpha', () => {
  it('grades from shallow to deep, monotonically', () => {
    expect(waterColorAlpha(0).a).toBeCloseTo(SHALLOW_ALPHA, 6);
    expect(waterColorAlpha(DEEP_FULL_M).a).toBeCloseTo(DEEP_ALPHA, 6);
    expect(waterColorAlpha(DEEP_FULL_M * 2).a).toBeCloseTo(DEEP_ALPHA, 6); // clamped
    let prev = -1;
    for (let d = 0; d <= DEEP_FULL_M; d += 100) {
      const a = waterColorAlpha(d).a;
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
  it('clamps negative depth to the shallow end', () => {
    expect(waterColorAlpha(-50)).toEqual(waterColorAlpha(0));
  });
  it('darkens color with depth', () => {
    expect(waterColorAlpha(DEEP_FULL_M).b).toBeLessThan(waterColorAlpha(0).b);
  });
});

describe('buildOceanGeometry', () => {
  it('puts every vertex exactly at the sea-level radius, normals outward', () => {
    const tiles = oceanTiles();
    const geom = buildOceanGeometry(tiles, 0, 2, 60)!;
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    const r = seaLevelRadius(tiles, 2, 60);
    for (let i = 0; i < pos.count; i++) {
      const len = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(len).toBeCloseTo(r, 6);
      // normal = unit position direction (a sphere's exact normal)
      expect(nrm.getX(i) * r).toBeCloseTo(pos.getX(i), 5);
      expect(nrm.getY(i) * r).toBeCloseTo(pos.getY(i), 5);
      expect(nrm.getZ(i) * r).toBeCloseTo(pos.getZ(i), 5);
    }
  });
  it('carries RGBA colors: alpha 0 over land, graded alpha over ocean', () => {
    const tiles = oceanTiles();
    const geom = buildOceanGeometry(tiles, 0, 2, 60)!;
    const color = geom.getAttribute('color');
    expect(color.itemSize).toBe(4);
    const alphas = new Set<number>();
    for (let i = 0; i < color.count; i++) alphas.add(color.getW(i));
    expect(alphas.has(0)).toBe(true); // land vertices exist on this face
    // 100 m deep ocean: the exact graded alpha, not a guess
    const expected = waterColorAlpha(100).a;
    expect([...alphas].some((a) => Math.abs(a - expected) < 1e-6)).toBe(true);
  });
  it('returns null for a face with no ocean at all', () => {
    const tiles = oceanTiles();
    tiles.ocean = tiles.ocean.map(() => false);
    expect(buildOceanGeometry(tiles, 0, 2, 60)).toBeNull();
  });
  it('wave UVs are the per-face grid — continuous, no antimeridian tear', () => {
    // Face 1 (the -X face) is where the old equirect mapping tore at ±180°.
    const geom = buildOceanGeometry(oceanTiles(), 1, 2, 60)!;
    const uv = geom.getAttribute('uv');
    const n = TILE_QUADS + 1;
    expect(uv.itemSize).toBe(2);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n - 1; col++) {
        const a = row * n + col;
        // Horizontally adjacent vertices step by exactly 1/TILE_QUADS —
        // a branch-cut jump would be ~1.0.
        expect(Math.abs(uv.getX(a + 1) - uv.getX(a))).toBeCloseTo(1 / TILE_QUADS, 10);
      }
    }
  });
});

describe('createOcean', () => {
  it('mounts one mesh per ocean-bearing face, raycast-transparent, watery material', () => {
    const ocean = createOcean(oceanTiles(), 2, 60);
    expect(ocean.object3d.name).toBe('ocean');
    const meshes = ocean.object3d.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      expect(m.name.startsWith('ocean-face-')).toBe(true);
      // Picking must pass through the water to the world beneath.
      const hits: THREE.Intersection[] = [];
      m.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1)), hits);
      expect(hits).toEqual([]);
      const mat = m.material as THREE.MeshStandardMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.vertexColors).toBe(true);
      expect(mat.roughness).toBeLessThan(0.5); // glossy enough to glint
    }
  });
  it('setTrueRelief moves the surface to the 1x sea-level radius and back', () => {
    const tiles = oceanTiles();
    const ocean = createOcean(tiles, 2, 60);
    const mesh = ocean.object3d.children.find((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh)!;
    const radiusOf = (m: THREE.Mesh) => {
      const p = m.geometry.getAttribute('position');
      return Math.hypot(p.getX(0), p.getY(0), p.getZ(0));
    };
    expect(radiusOf(mesh)).toBeCloseTo(seaLevelRadius(tiles, 2, 60), 6);
    ocean.setTrueRelief(true);
    expect(radiusOf(mesh)).toBeCloseTo(seaLevelRadius(tiles, 2, 1), 6);
    ocean.setTrueRelief(false);
    expect(radiusOf(mesh)).toBeCloseTo(seaLevelRadius(tiles, 2, 60), 6);
  });
  it('setGlint flips the ocean between glossy (glint on) and matte (off)', () => {
    const ocean = createOcean(oceanTiles(), 2, 60);
    const mat = (ocean.object3d.children.find((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh)!)
      .material as THREE.MeshStandardMaterial;
    expect(mat.roughness).toBeLessThan(0.5); // glint on by default
    ocean.setGlint(false);
    expect(mat.roughness).toBeGreaterThan(0.5); // matte, no specular highlight
    ocean.setGlint(true);
    expect(mat.roughness).toBeLessThan(0.5); // back to glossy
  });
  it('setWaves drops the wave normal map and leaves the glint untouched', () => {
    const ocean = createOcean(oceanTiles(), 2, 60);
    const mat = (ocean.object3d.children.find((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh)!)
      .material as THREE.MeshStandardMaterial;
    const roughnessBefore = mat.roughness;
    ocean.setWaves(false);
    expect(mat.normalMap).toBeNull();
    expect(mat.roughness).toBe(roughnessBefore); // independent of the glint toggle
    ocean.setWaves(true); // safe even headless (the built map is null there)
    expect(mat.roughness).toBe(roughnessBefore);
  });
});

describe('wave drift', () => {
  it('waveOffset is a pure, wrapped function of the sim day', () => {
    expect(waveOffset(0)).toEqual({ x: 0, y: 0 });
    const a = waveOffset(12.375);
    expect(waveOffset(12.375)).toEqual(a); // deterministic
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x).toBeLessThan(1);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeLessThan(1);
    // Distinct days give distinct sea states.
    expect(waveOffset(12.5)).not.toEqual(a);
  });
  it('update(day) survives a DOM with no 2D canvas (happy-dom)', () => {
    const ocean = createOcean(oceanTiles(), 2, 60);
    expect(() => ocean.update(42.5)).not.toThrow();
  });
});
