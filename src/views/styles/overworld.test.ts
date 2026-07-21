import { describe, expect, test } from 'vitest';
import { overworldRGBA, OVERWORLD_PALETTE } from './overworld';
import type { RegionScene } from '../../sim/scene';

/** A 2x2-node region (samples=1): node 0 (top-left, row0/col0) is a shallow
 * ocean cell, nodes 1-3 are a known land biome. Mirrors the fixture pattern
 * in `mapTexture.test.ts`/`mapView.test.ts` (partial `RegionScene`, cast
 * through `unknown`). */
function miniRegion(overrides: Partial<RegionScene> = {}): RegionScene {
  const samples = 1;
  const n = (samples + 1) * (samples + 1); // 4 nodes
  return {
    schema: 'scene/tiles-region/v1',
    seed: 1,
    face: 0,
    level: 3,
    ix: 0,
    iy: 0,
    samples,
    sea_level_m: 0,
    season_period_days: 360,
    circulationBands: 3,
    biomeLegend: ['temperate-forest'],
    elevation_m: [-100, 500, 500, 500],
    ocean: [true, false, false, false],
    biome: [0, 0, 0, 0],
    plate: Array.from({ length: n }, () => 0),
    unrest: Array.from({ length: n }, () => 0),
    t_mean_c: Array.from({ length: n }, () => 10),
    t_swing_c: Array.from({ length: n }, () => 5),
    moisture: Array.from({ length: n }, () => 0.5),
    water: Array.from({ length: n }, () => 0),
    waterLegend: [],
    drainage: Array.from({ length: n }, () => 0),
    waterfalls: [],
    ...overrides,
  } as unknown as RegionScene;
}

/** `(r,g,b)` at output pixel `(x,y)` of a `dim x dim` RGBA buffer. */
function pixelAt(buf: Uint8Array, dim: number, x: number, y: number): [number, number, number] {
  const o = (y * dim + x) * 4;
  return [buf[o]!, buf[o + 1]!, buf[o + 2]!];
}

/** Alpha channel at output pixel `(x,y)`. */
function alphaAt(buf: Uint8Array, dim: number, x: number, y: number): number {
  return buf[(y * dim + x) * 4 + 3]!;
}

/** A uniform-biome, uniform-elevation region (all 4 nodes the same land
 * biome at the same elevation) — isolates the Bayer dither's own texture
 * from any node-to-node variation, so a test can assert the dither alone
 * produces both the biome's light and dark tones. */
function flatBiomeRegion(biomeName: string, elevationM = 400): RegionScene {
  const samples = 1;
  const n = (samples + 1) * (samples + 1); // 4 nodes
  return {
    schema: 'scene/tiles-region/v1',
    seed: 1,
    face: 0,
    level: 3,
    ix: 0,
    iy: 0,
    samples,
    sea_level_m: 0,
    season_period_days: 360,
    circulationBands: 3,
    biomeLegend: [biomeName],
    elevation_m: Array.from({ length: n }, () => elevationM),
    ocean: Array.from({ length: n }, () => false),
    biome: Array.from({ length: n }, () => 0),
    plate: Array.from({ length: n }, () => 0),
    unrest: Array.from({ length: n }, () => 0),
    t_mean_c: Array.from({ length: n }, () => 10),
    t_swing_c: Array.from({ length: n }, () => 5),
    moisture: Array.from({ length: n }, () => 0.5),
    water: Array.from({ length: n }, () => 0),
    waterLegend: [],
    drainage: Array.from({ length: n }, () => 0),
    waterfalls: [],
  } as unknown as RegionScene;
}

/** The set of distinct `(r,g,b)` colors present anywhere in a `dim x dim`
 * RGBA buffer (alpha ignored). */
function distinctColors(buf: Uint8Array): Array<[number, number, number]> {
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < buf.length; i += 4) {
    const key = `${buf[i]},${buf[i + 1]},${buf[i + 2]}`;
    if (!seen.has(key)) seen.set(key, [buf[i]!, buf[i + 1]!, buf[i + 2]!]);
  }
  return Array.from(seen.values());
}

describe('overworldRGBA — palette fill', () => {
  test('colors each output pixel by its nearest region node biome', () => {
    const region = miniRegion();
    const buf = overworldRGBA(region, 8); // 8x8 output
    expect(buf.length).toBe(8 * 8 * 4);
    // a pixel over the ocean cell (node 0, top-left) is an ocean tone
    expect(pixelAt(buf, 8, 1, 1)).toEqual(OVERWORLD_PALETTE.ocean.shallow);
    // a pixel over the forest cells (nodes 1-3) is that biome's light tone
    expect(pixelAt(buf, 8, 6, 6)).toEqual(OVERWORLD_PALETTE.biome['temperate-forest']!.light);
    expect(alphaAt(buf, 8, 4, 4)).toBe(255);
  });

  test('is deterministic — identical output for identical input', () => {
    const r = miniRegion();
    expect(overworldRGBA(r, 16)).toEqual(overworldRGBA(r, 16));
  });

  test('a deep ocean node (well below the deep threshold) takes the deep tone', () => {
    const region = miniRegion({
      elevation_m: [-5000, 500, 500, 500],
    });
    const buf = overworldRGBA(region, 8);
    expect(pixelAt(buf, 8, 1, 1)).toEqual(OVERWORLD_PALETTE.ocean.deep);
  });

  test('an inland river node takes the river tone, distinct from ocean and land', () => {
    const region = miniRegion({
      ocean: [false, false, false, false],
      water: [2, 0, 0, 0],
      waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    });
    const buf = overworldRGBA(region, 8);
    const river = pixelAt(buf, 8, 1, 1);
    expect(river).toEqual(OVERWORLD_PALETTE.river);
    expect(river).not.toEqual(OVERWORLD_PALETTE.ocean.shallow);
    expect(river).not.toEqual(OVERWORLD_PALETTE.biome['temperate-forest']!.light);
  });

  test('OVERWORLD_PALETTE biome tones have a light/dark pair that differ', () => {
    const forest = OVERWORLD_PALETTE.biome['temperate-forest']!;
    expect(forest.light).not.toEqual(forest.dark);
  });
});

describe('overworldRGBA — within-biome Bayer dithering', () => {
  test('dithers each biome between its light/dark tones by the Bayer matrix', () => {
    const region = flatBiomeRegion('temperate-forest'); // uniform biome + elevation
    const buf = overworldRGBA(region, 16);
    const tones = distinctColors(buf); // should contain BOTH light and dark forest tones
    expect(tones).toContainEqual(OVERWORLD_PALETTE.biome['temperate-forest']!.light);
    expect(tones).toContainEqual(OVERWORLD_PALETTE.biome['temperate-forest']!.dark);
  });

  test('the dither is deterministic in (px, py) — identical output for identical input', () => {
    const region = flatBiomeRegion('temperate-forest');
    expect(overworldRGBA(region, 16)).toEqual(overworldRGBA(region, 16));
  });

  test('a flat-elevation biome shows only its own two tones (no stray colors)', () => {
    const region = flatBiomeRegion('desert');
    const buf = overworldRGBA(region, 16);
    const tones = distinctColors(buf);
    const desert = OVERWORLD_PALETTE.biome['desert']!;
    expect(tones.length).toBe(2);
    expect(tones).toContainEqual(desert.light);
    expect(tones).toContainEqual(desert.dark);
  });
});
