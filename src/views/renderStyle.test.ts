import { expect, test } from 'vitest';
import { STYLES, styleById, photorealStyle } from './renderStyle';

test('STYLES has photoreal first and every entry has a unique id + label', () => {
  expect(STYLES[0]).toBe(photorealStyle);
  const ids = STYLES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length); // unique
  for (const s of STYLES) expect(s.label.length).toBeGreaterThan(0);
});

test('styleById returns the match, and falls back to photoreal for an unknown id', () => {
  expect(styleById('photoreal')).toBe(photorealStyle);
  expect(styleById('nope-not-a-style')).toBe(photorealStyle);
});

test('photoreal produces an empty effect chain (identity)', () => {
  const fakeTiles = { width: 1, height: 1, elevation_m: [0], biome: [0] } as never;
  expect(photorealStyle.passes(fakeTiles)).toEqual([]);
});

test('pixel-art is a scene-renderer style (base + symbol layer, no post pass)', () => {
  const s = STYLES.find((x) => x.id === 'pixel-art')!;
  expect(s.base?.id).toBe('pixel');
  expect(s.symbolLayer).toBeDefined();
  expect(s.passes({ ocean: [], biome: [], biomeLegend: [] } as any)).toEqual([]);
});

test('photoreal and filter styles declare no base or symbol layer', () => {
  for (const s of STYLES) {
    if (s.id === 'photoreal' || s.id === 'cel' || s.id === 'engraving' || s.id === 'watercolor') {
      expect(s.base).toBeUndefined();
      expect(s.symbolLayer).toBeUndefined();
    }
  }
  expect(photorealStyle.base).toBeUndefined();
});
