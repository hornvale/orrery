import { describe, expect, it } from 'vitest';
import { TILES_WIDTH_LOCKED, TILES_WIDTH_OVERLAY, tilesWidthFor } from './tilesWidth';

describe('tiles export width', () => {
  it('demotes a spinning world to the overlay width', () => {
    expect(tilesWidthFor({ dayLengthDays: 1 })).toBe(TILES_WIDTH_OVERLAY);
  });

  it('keeps the full width for a locked world, which cannot use region patches', () => {
    expect(tilesWidthFor({ dayLengthDays: null })).toBe(TILES_WIDTH_LOCKED);
  });

  it('only ever asks for widths the producer accepts (even, 16..=1024)', () => {
    for (const w of [TILES_WIDTH_OVERLAY, TILES_WIDTH_LOCKED]) {
      expect(w % 2).toBe(0);
      expect(w).toBeGreaterThanOrEqual(16);
      expect(w).toBeLessThanOrEqual(1024);
    }
  });
});
