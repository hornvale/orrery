import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEEP_ALPHA,
  DEEP_FULL_M,
  SHALLOW_ALPHA,
  seaLevelRadius,
  waterColorAlpha,
  buildOceanGeometry,
} from './ocean';
import { REFERENCE_RADIUS_M } from './worldMesh';
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
});
