import { describe, expect, it } from 'vitest';
import { illuminatedFraction, litOffset } from './moon';

describe('illuminatedFraction', () => {
  it('new 0, full 1, quarter 0.5', () => {
    expect(illuminatedFraction(0)).toBeCloseTo(0, 9);
    expect(illuminatedFraction(0.5)).toBeCloseTo(1, 9);
    expect(illuminatedFraction(0.25)).toBeCloseTo(0.5, 9);
  });
});

describe('litOffset', () => {
  it('half at quarter, full disc at new/full', () => {
    // litOffset returns the terminator ellipse x-radius as a fraction of r:
    // |1-2k|. Quarter (k=.5) → 0 (straight terminator); new/full → 1.
    expect(litOffset(0.25)).toBeCloseTo(0, 9);
    expect(litOffset(0.5)).toBeCloseTo(1, 9);
    expect(litOffset(0.125)).toBeGreaterThan(0);
    expect(litOffset(0.125)).toBeLessThan(1);
  });
});
