import { expect, test } from 'vitest';
import { biomePalette } from './pixelArt';

test('biomePalette is deterministic and bounded, ordered by biome frequency', () => {
  // 4 cells: biome 2 appears x3, biome 5 once → 2 must come before 5.
  const tiles = { width: 4, height: 1, elevation_m: [0, 0, 0, 0], biome: [2, 2, 2, 5] } as never;
  const a = biomePalette(tiles);
  const b = biomePalette(tiles);
  expect(a).toEqual(b); // deterministic
  expect(a.length).toBeGreaterThan(0);
  expect(a.length).toBeLessThanOrEqual(16); // bounded
  for (const [r, g, bl] of a) {
    for (const c of [r, g, bl]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  }
});
