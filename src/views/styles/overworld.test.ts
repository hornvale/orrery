import { describe, expect, test } from 'vitest';
import { overworldRGBA, OVERWORLD_PALETTE, COAST_BAND_PX, FOAM_BAND_PX } from './overworld';
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

/** An 8x8-node region (samples=7): the left half of node columns (0-3) is
 * shallow ocean, the right half (4-7) is a known land biome — a clean
 * vertical land/water boundary for the coastline tests (Task 3). Enough
 * nodes per side that the boundary sits away from the texture's own edges,
 * so out-of-bounds neighbor lookups don't confound the assertions. */
function splitRegion(biomeName = 'temperate-forest'): RegionScene {
  const samples = 7;
  const nodesPerSide = samples + 1; // 8
  const n = nodesPerSide * nodesPerSide; // 64
  const ocean: boolean[] = [];
  const elevation_m: number[] = [];
  const biome: number[] = [];
  for (let row = 0; row < nodesPerSide; row++) {
    for (let col = 0; col < nodesPerSide; col++) {
      const isOcean = col < nodesPerSide / 2;
      ocean.push(isOcean);
      elevation_m.push(isOcean ? -100 : 400);
      biome.push(0);
    }
  }
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
    elevation_m,
    ocean,
    biome,
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

/** Whether any pixel in output column `x` of a `dim x dim` RGBA buffer
 * carries `tone`. */
function columnContains(buf: Uint8Array, dim: number, x: number, tone: readonly [number, number, number]): boolean {
  for (let y = 0; y < dim; y++) {
    if (pixelAt(buf, dim, x, y).join(',') === tone.join(',')) return true;
  }
  return false;
}

/** An 8x8-node region (samples=7), all LAND (no ocean): the left half of
 * node columns (0-3) is one biome, the right half (4-7) is a second biome —
 * a clean vertical biome/biome boundary with no water anywhere, isolating
 * Task 4's internal biome-boundary outline from Task 3's land/water
 * coastline outline. Mirrors `splitRegion`'s shape (same node grid, same
 * boundary math) so the boundary column lands at the same output pixel
 * (`boundaryCol = 16` at `dim = 32`). */
function splitBiomeRegion(leftBiome = 'desert', rightBiome = 'temperate-forest'): RegionScene {
  const samples = 7;
  const nodesPerSide = samples + 1; // 8
  const n = nodesPerSide * nodesPerSide; // 64
  const elevation_m: number[] = [];
  const biome: number[] = [];
  for (let row = 0; row < nodesPerSide; row++) {
    for (let col = 0; col < nodesPerSide; col++) {
      const isLeft = col < nodesPerSide / 2;
      elevation_m.push(400);
      biome.push(isLeft ? 0 : 1);
    }
  }
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
    biomeLegend: [leftBiome, rightBiome],
    elevation_m,
    ocean: Array.from({ length: n }, () => false),
    biome,
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

describe('overworldRGBA — crafted coastlines', () => {
  // splitRegion's node grid is 8x8 (samples=7); at dim=32 the ocean/land
  // node-column boundary (col 3 vs col 4) falls at output column 16 — the
  // land side of the boundary.
  const dim = 32;
  const boundaryCol = 16;

  test('the land-side boundary column carries the outline tone', () => {
    const region = splitRegion();
    const buf = overworldRGBA(region, dim);
    expect(columnContains(buf, dim, boundaryCol, OVERWORLD_PALETTE.outline)).toBe(true);
  });

  test('water just inside the boundary carries the shallows tone, not open ocean', () => {
    const region = splitRegion();
    const buf = overworldRGBA(region, dim);
    const pixel = pixelAt(buf, dim, boundaryCol - 1, 16);
    expect(pixel).toEqual(OVERWORLD_PALETTE.shallows);
    expect(pixel).not.toEqual(OVERWORLD_PALETTE.ocean.shallow);
    expect(pixel).not.toEqual(OVERWORLD_PALETTE.ocean.deep);
  });

  test('foam appears somewhere in the water column just outside the outline', () => {
    const region = splitRegion();
    const buf = overworldRGBA(region, dim);
    expect(columnContains(buf, dim, boundaryCol - 1, OVERWORLD_PALETTE.foam)).toBe(true);
  });

  test('open ocean well away from shore keeps its ordinary depth-dithered tones, no shallows/foam', () => {
    const region = splitRegion();
    const buf = overworldRGBA(region, dim);
    const openOceanCol = boundaryCol - 1 - COAST_BAND_PX - 2; // safely past the shallows band
    for (let y = 0; y < dim; y++) {
      const pixel = pixelAt(buf, dim, openOceanCol, y);
      expect(pixel).not.toEqual(OVERWORLD_PALETTE.shallows);
      expect(pixel).not.toEqual(OVERWORLD_PALETTE.foam);
      expect(pixel).not.toEqual(OVERWORLD_PALETTE.outline);
    }
  });

  test('land away from the shore is never painted with the outline tone', () => {
    const region = splitRegion();
    const buf = overworldRGBA(region, dim);
    const inlandCol = boundaryCol + 1 + FOAM_BAND_PX + 2; // safely past the boundary column
    for (let y = 0; y < dim; y++) {
      expect(pixelAt(buf, dim, inlandCol, y)).not.toEqual(OVERWORLD_PALETTE.outline);
    }
  });

  test('is deterministic — identical output for identical input', () => {
    const region = splitRegion();
    expect(overworldRGBA(region, dim)).toEqual(overworldRGBA(region, dim));
  });
});

describe('overworldRGBA — palette fill', () => {
  test('colors each output pixel by its nearest region node biome', () => {
    const region = miniRegion();
    const buf = overworldRGBA(region, 8); // 8x8 output
    expect(buf.length).toBe(8 * 8 * 4);
    // Sampled at dim=32 (not 8) so the ocean/land sample points sit well
    // outside Task 3's coastal band (COAST_BAND_PX) around miniRegion's
    // single-ocean-node/land boundary — this test is about nearest-node
    // membership, not the coastline feature (see the dedicated coastline
    // describe block above).
    const coastalBuf = overworldRGBA(region, 32);
    // a pixel over the ocean cell (node 0, top-left) is one of the ocean
    // tones — membership, not a specific tone, so this doesn't couple to
    // BAYER_4/OVERWORLD_DITHER_STRENGTH's threshold (Task 5 retunes those);
    // a wrong nearest-node resolution would still land outside this set.
    expect([OVERWORLD_PALETTE.ocean.shallow, OVERWORLD_PALETTE.ocean.deep]).toContainEqual(
      pixelAt(coastalBuf, 32, 4, 4),
    );
    // a pixel over the forest cells (nodes 1-3) is one of that biome's tones
    // — same membership rationale.
    expect([
      OVERWORLD_PALETTE.biome['temperate-forest']!.light,
      OVERWORLD_PALETTE.biome['temperate-forest']!.dark,
    ]).toContainEqual(pixelAt(coastalBuf, 32, 24, 24));
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
    // dim=32, sampled well outside the coastal band — see the comment above.
    const buf = overworldRGBA(region, 32);
    expect(pixelAt(buf, 32, 4, 4)).toEqual(OVERWORLD_PALETTE.ocean.deep);
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

describe('overworldRGBA — biome-boundary outlines', () => {
  // splitBiomeRegion's node grid is 8x8 (samples=7); at dim=32 the
  // desert/forest node-column boundary (col 3 vs col 4) falls at output
  // column 16, same as splitRegion's land/ocean boundary.
  const dim = 32;
  const boundaryCol = 16;

  test('the biome/biome boundary column carries the outline tone', () => {
    const region = splitBiomeRegion();
    const buf = overworldRGBA(region, dim);
    expect(columnContains(buf, dim, boundaryCol, OVERWORLD_PALETTE.outline)).toBe(true);
  });

  test('desert interior, away from the boundary, is never painted with the outline tone', () => {
    const region = splitBiomeRegion();
    const buf = overworldRGBA(region, dim);
    const desertInteriorCol = boundaryCol - 1 - 2; // safely past the boundary column
    for (let y = 0; y < dim; y++) {
      expect(pixelAt(buf, dim, desertInteriorCol, y)).not.toEqual(OVERWORLD_PALETTE.outline);
    }
  });

  test('forest interior, away from the boundary, is never painted with the outline tone', () => {
    const region = splitBiomeRegion();
    const buf = overworldRGBA(region, dim);
    const forestInteriorCol = boundaryCol + 1 + 2; // safely past the boundary column
    for (let y = 0; y < dim; y++) {
      expect(pixelAt(buf, dim, forestInteriorCol, y)).not.toEqual(OVERWORLD_PALETTE.outline);
    }
  });

  test('interiors show their own biome tones, not stray colors', () => {
    const region = splitBiomeRegion();
    const buf = overworldRGBA(region, dim);
    const desert = OVERWORLD_PALETTE.biome['desert']!;
    const forest = OVERWORLD_PALETTE.biome['temperate-forest']!;
    const desertInteriorCol = boundaryCol - 1 - 2;
    const forestInteriorCol = boundaryCol + 1 + 2;
    for (let y = 0; y < dim; y++) {
      expect([desert.light, desert.dark]).toContainEqual(pixelAt(buf, dim, desertInteriorCol, y));
      expect([forest.light, forest.dark]).toContainEqual(pixelAt(buf, dim, forestInteriorCol, y));
    }
  });

  test('a single-biome land region never paints the outline tone', () => {
    const region = splitBiomeRegion('desert', 'desert');
    const buf = overworldRGBA(region, dim);
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        expect(pixelAt(buf, dim, x, y)).not.toEqual(OVERWORLD_PALETTE.outline);
      }
    }
  });

  test('is deterministic — identical output for identical input', () => {
    const region = splitBiomeRegion();
    expect(overworldRGBA(region, dim)).toEqual(overworldRGBA(region, dim));
  });
});
