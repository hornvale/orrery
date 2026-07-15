import { describe, expect, it } from 'vitest';
import { illuminatedFraction } from './moon';

describe('illuminatedFraction', () => {
  it('new 0, full 1, quarter 0.5', () => {
    expect(illuminatedFraction(0)).toBeCloseTo(0, 9);
    expect(illuminatedFraction(0.5)).toBeCloseTo(1, 9);
    expect(illuminatedFraction(0.25)).toBeCloseTo(0.5, 9);
  });
});
