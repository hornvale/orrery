import { describe, expect, it } from 'vitest';
import { moonTexture, moonTextureData } from './moonTexture';
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

describe('moonTextureData', () => {
  it('is deterministic: same seed + index + surface produces identical pixel data', () => {
    const a = moonTextureData(42, 0, surface());
    const b = moonTextureData(42, 0, surface());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs across moon index at the same seed', () => {
    const a = moonTextureData(42, 0, surface());
    const b = moonTextureData(42, 1, surface());
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('differs across seed at the same index', () => {
    const a = moonTextureData(42, 0, surface());
    const b = moonTextureData(7, 0, surface());
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('is fully opaque (alpha 255 throughout)', () => {
    const data = moonTextureData(42, 0, surface());
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(255);
    }
  });
});

describe('moonTexture', () => {
  it('wraps moonTextureData into a matching DataTexture', () => {
    const surf = surface();
    const tex = moonTexture(42, 0, surf);
    const raw = moonTextureData(42, 0, surf);
    expect(Array.from(tex.image.data as Uint8ClampedArray)).toEqual(Array.from(raw));
  });
});
