import { describe, expect, it } from 'vitest';
import { moonBaseColor, moonRadiusUnitsFromKm } from './moonShading';
import type { MoonSurface } from '../sim/scene';

function surface(overrides: Partial<MoonSurface> = {}): MoonSurface {
  return {
    index: 0,
    massRel: 1,
    radiusKm: 1737.4,
    surfaceGravityMs2: 1.62,
    albedo: 0.14,
    cratering: 0.3,
    mariaFraction: 0.5,
    tint: [0.7, 0.7, 0.7],
    surfaceClass: 'maria-rich',
    densityGCm3: 3.34,
    formation: 'giant-impact',
    ...overrides,
  };
}

describe('moonBaseColor', () => {
  it('a higher albedo yields a strictly brighter color at the same tint', () => {
    const dark = moonBaseColor(surface({ albedo: 0.05 }));
    const bright = moonBaseColor(surface({ albedo: 0.5 }));
    expect(bright.r).toBeGreaterThan(dark.r);
    expect(bright.g).toBeGreaterThan(dark.g);
    expect(bright.b).toBeGreaterThan(dark.b);
  });

  it('tint sets hue at a fixed albedo — a warmer tint yields a warmer color', () => {
    const warm = moonBaseColor(surface({ tint: [0.8, 0.5, 0.4] }));
    const cool = moonBaseColor(surface({ tint: [0.4, 0.5, 0.8] }));
    expect(warm.r).toBeGreaterThan(warm.b);
    expect(cool.b).toBeGreaterThan(cool.r);
  });

  it('clamps rather than overflowing at high albedo', () => {
    const c = moonBaseColor(surface({ albedo: 1, tint: [1, 1, 1] }));
    expect(c.r).toBeLessThanOrEqual(1);
    expect(c.g).toBeLessThanOrEqual(1);
    expect(c.b).toBeLessThanOrEqual(1);
  });
});

describe('moonRadiusUnitsFromKm', () => {
  it('is monotonically increasing in radiusKm at true scale', () => {
    expect(moonRadiusUnitsFromKm(1846, true)).toBeGreaterThan(moonRadiusUnitsFromKm(1279, true));
  });

  it('is monotonically increasing in radiusKm at schematic scale (within the clamp)', () => {
    expect(moonRadiusUnitsFromKm(2000, false)).toBeGreaterThan(moonRadiusUnitsFromKm(1000, false));
  });

  it('true and schematic scales produce different sizes for the same radius', () => {
    const trueVal = moonRadiusUnitsFromKm(1737.4, true);
    const schematicVal = moonRadiusUnitsFromKm(1737.4, false);
    expect(trueVal).not.toBeCloseTo(schematicVal, 3);
  });
});
