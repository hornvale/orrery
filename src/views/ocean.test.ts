import { describe, expect, it } from 'vitest';
import {
  DEEP_ALPHA,
  DEEP_FULL_M,
  SHALLOW_ALPHA,
  seaLevelRadius,
  waterColorAlpha,
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
