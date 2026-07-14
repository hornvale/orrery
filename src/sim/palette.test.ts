import { describe, expect, it } from 'vitest';
import { elevationColor, starTint } from './palette';

describe('elevationColor', () => {
  it('ocean is bluer than land at the same delta', () => {
    const sea = elevationColor(0, 400);
    const land = elevationColor(800, 400);
    expect(sea[2]).toBeGreaterThan(sea[0]);
    expect(land[1]).toBeGreaterThanOrEqual(land[2]);
  });
});

describe('starTint', () => {
  it('is total and hot≠cool', () => {
    const g = starTint('yellow dwarf (G)');
    const m = starTint('red dwarf (M)');
    expect(g.length).toEqual(3);
    expect(g[0]! + g[1]! > m[1]! + m[2]! || g[2]! > m[2]!).toBe(true);
  });

  it("F-type stars are warm, matching the sim's star_color (F groups with G)", () => {
    expect(starTint('yellow-white dwarf (F)')).toEqual(starTint('yellow dwarf (G)'));
  });
});
