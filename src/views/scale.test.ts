import { describe, expect, it } from 'vitest';
import {
  MM_PER_AU, moonOrbitRadiusUnits, moonRadiusUnits, starRadiusUnits, worldRadiusUnits,
} from './scale';

describe('true-scale mapping (AU_SCALE = 3 world units per AU)', () => {
  it('schematic moon rungs are the even ladder', () => {
    expect(moonOrbitRadiusUnits(0, 384, false)).toBeCloseTo(0.32, 10);
    expect(moonOrbitRadiusUnits(2, 999, false)).toBeCloseTo(0.32 + 2 * 0.22, 10);
  });
  it('true moon rungs come from distanceMm through the AU scale', () => {
    expect(moonOrbitRadiusUnits(0, 384, true)).toBeCloseTo((384 / MM_PER_AU) * 3, 10);
  });
  it('true radii use the reference conventions (Earth, Sol, Luna x sizeRel)', () => {
    expect(worldRadiusUnits(false)).toBeCloseTo(0.12, 10);
    expect(worldRadiusUnits(true)).toBeCloseTo((6.371 / MM_PER_AU) * 3, 10);
    expect(starRadiusUnits(true)).toBeCloseTo((696 / MM_PER_AU) * 3, 10);
    expect(moonRadiusUnits(1, true)).toBeCloseTo((1.7375 / MM_PER_AU) * 3, 10);
  });
});
