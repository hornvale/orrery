import { describe, expect, it } from 'vitest';
import {
  DITHER_LEVELS, DITHER_RES, bayerMatrix, bayerValue, buildDitherData,
} from './ditherTexture';

describe('the Bayer matrices', () => {
  it('is a single zero at level 0', () => {
    expect(bayerMatrix(0)).toEqual([0]);
  });

  it('is the canonical 2x2 at level 1', () => {
    expect(bayerMatrix(1)).toEqual([0, 2, 3, 1]);
  });

  // A pure regression pin, not a derivation: the shipped values were checked
  // by hand twice, independently, and agreed. What is missing is a test that
  // can FAIL if they change. "Is a permutation of 0..n^2-1" holds for many
  // wrong matrices, and the fractal-average property below only constrains
  // the four-offset set to sum to 6 — so a transposition or a swapped pair
  // introduced at level 2 or finer passes both existing tests silently, and
  // level >= 2 is where every visible dither cell actually comes from.
  it('is the canonical 4x4 at level 2 — the actual values, not just a permutation of them', () => {
    expect(bayerMatrix(2)).toEqual([
      0, 2, 8, 10,
      3, 1, 11, 9,
      12, 14, 4, 6,
      15, 13, 7, 5,
    ]);
  });

  it('is a permutation of 0..size^2-1 at every level', () => {
    for (let level = 0; level < DITHER_LEVELS; level++) {
      const m = bayerMatrix(level);
      const size = 1 << level;
      expect(m.length).toBe(size * size);
      expect([...m].sort((a, b) => a - b)).toEqual([...Array(size * size).keys()]);
    }
  });
});

describe('the fractal property', () => {
  it('THE PROPERTY: each 2x2 block of level k+1 averages exactly to level k', () => {
    for (let level = 0; level < DITHER_LEVELS - 1; level++) {
      const size = 1 << level;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const avg = (
            bayerValue(level + 1, 2 * x, 2 * y) +
            bayerValue(level + 1, 2 * x + 1, 2 * y) +
            bayerValue(level + 1, 2 * x, 2 * y + 1) +
            bayerValue(level + 1, 2 * x + 1, 2 * y + 1)
          ) / 4;
          expect(avg).toBeCloseTo(bayerValue(level, x, y), 12);
        }
      }
    }
  });

  it('keeps every value strictly inside (0,1), so no dot is ever unconditionally on or off', () => {
    for (let level = 0; level < DITHER_LEVELS; level++) {
      const size = 1 << level;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = bayerValue(level, x, y);
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThan(1);
        }
      }
    }
  });

  it('centres the single level-0 value at one half', () => {
    expect(bayerValue(0, 0, 0)).toBe(0.5);
  });
});

describe('the packed 3D data', () => {
  it('is one byte per texel, RES^2 per slice, one slice per level', () => {
    expect(buildDitherData().length).toBe(DITHER_RES * DITHER_RES * DITHER_LEVELS);
  });

  it('block-replicates a coarse level up to the common slice resolution', () => {
    const data = buildDitherData();
    // Level 0 is a single value, so its whole slice is uniform.
    const slice0 = data.subarray(0, DITHER_RES * DITHER_RES);
    expect(new Set(slice0).size).toBe(1);
  });

  it('gives the finest level as many distinct values as it has cells', () => {
    const data = buildDitherData();
    const last = DITHER_LEVELS - 1;
    const slice = data.subarray(last * DITHER_RES * DITHER_RES, (last + 1) * DITHER_RES * DITHER_RES);
    expect(new Set(slice).size).toBe(DITHER_RES * DITHER_RES);
  });
});
