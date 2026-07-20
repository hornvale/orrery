import { describe, expect, test } from 'vitest';
import { extractPeaks, extractForests } from './extract';
import type { TilesScene } from '../../sim/scene';

// A tiny 4x3 world builder. legend index 1 = 'temperate-forest' (a FOREST_BIOMES
// member), index 0 = 'desert' (not). ocean true => water.
function world(elev: number[], ocean: boolean[], biome: number[]): TilesScene {
  return {
    schema: 'scene/tiles/v1', width: 4, height: 3, sea_level_m: 0,
    elevation_m: elev, ocean, biome, biomeLegend: ['desert', 'temperate-forest'],
    plate: [], unrest: [], features: [],
  } as unknown as TilesScene;
}

test('extractPeaks finds land local maxima, tallest first', () => {
  const elev = [10, 10, 10, 10,  10, 500, 10, 10,  10, 10, 300, 10];
  const ocean = elev.map(() => false);
  const biome = elev.map(() => 0);
  const peaks = extractPeaks(world(elev, ocean, biome));
  expect(peaks.map((p) => p.tileIndex)).toEqual([5, 10]);
  expect(peaks[0]!.elevationM).toBe(500);
});

test('extractPeaks ignores ocean tiles', () => {
  const elev = [10, 10, 10, 10,  10, 500, 10, 10,  10, 10, 10, 10];
  const ocean = elev.map((_, i) => i === 5);
  const peaks = extractPeaks(world(elev, ocean, elev.map(() => 0)));
  expect(peaks.find((p) => p.tileIndex === 5)).toBeUndefined();
});

test('extractForests clusters contiguous forest biome, largest first', () => {
  const biome = [1, 1, 0, 0,  1, 1, 0, 0,  0, 0, 0, 1];
  const elev = biome.map(() => 100);
  const forests = extractForests(world(elev, biome.map(() => false), biome));
  expect(forests.length).toBe(2);
  expect(forests[0]!.area).toBe(4);
  expect(forests[1]!.area).toBe(1);
});
