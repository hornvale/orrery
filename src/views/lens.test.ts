import { describe, expect, it } from 'vitest';
import { LENSES, lensById, naturalLens } from './lens';
import { loadSeed42Tiles } from '../testHelpers/wasmFixture';
import { HEX } from './colormap';
import { elevationColor } from '../sim/palette';
import { moistureLens, temperatureLens, topographicLens, unrestLens } from './lens';
import type { TilesScene } from '../sim/scene';

/** A 1-tile scene carrying only what the scalar lenses read. */
const oneTile = (fields: Partial<TilesScene>): TilesScene =>
  ({
    width: 1,
    height: 1,
    sea_level_m: 0,
    elevation_m: [0],
    ocean: [false],
    biome: [0],
    biomeLegend: ['tundra'],
    features: [],
    t_mean_c: [0],
    t_swing_c: [0],
    season_period_days: 365,
    circulationBands: 3,
    moisture: [0],
    plate: [0],
    unrest: [0],
    ...fields,
  }) as never;

describe('the lens registry', () => {
  it('registers natural first', () => {
    expect(LENSES[0]!.id).toBe('natural');
  });

  it('gives every lens a label, a caption, and a legend', async () => {
    const tiles = await loadSeed42Tiles(64);
    for (const lens of LENSES) {
      expect(lens.label.length, lens.id).toBeGreaterThan(0);
      expect(lens.caption.length, lens.id).toBeGreaterThan(0);
      expect(lens.legend(tiles).length, lens.id).toBeGreaterThan(0);
    }
  });

  it('falls back to natural for an unknown id', () => {
    expect(lensById('no-such-lens').id).toBe('natural');
  });

  it('sets dependsOnDay iff colorAt actually varies with the day', async () => {
    const tiles = await loadSeed42Tiles(64);
    for (const lens of LENSES) {
      const varies = Array.from({ length: tiles.width * tiles.height }, (_, i) => i).some(
        (i) => String(lens.colorAt(tiles, i, 0)) !== String(lens.colorAt(tiles, i, 100)),
      );
      expect(varies, `${lens.id} dependsOnDay`).toBe(lens.dependsOnDay);
    }
  });
});

describe('the temperature lens', () => {
  it('is the only living lens', () => {
    expect(temperatureLens.dependsOnDay).toBe(true);
    for (const l of LENSES.filter((l) => l.id !== 'temperature')) {
      expect(l.dependsOnDay, l.id).toBe(false);
    }
  });

  it('is neutral at freezing, blue when cold, red when hot', () => {
    // t_swing_c 0 kills the season, so t_mean_c IS the temperature on any day.
    const at = (mean: number) =>
      temperatureLens.colorAt(oneTile({ t_mean_c: [mean], t_swing_c: [0] }), 0, 0);
    expect(at(0)).toEqual(HEX('#f0efec'));      // the neutral midpoint
    expect(at(-40)).toEqual(HEX('#2a78d6'));    // the cold pole
    expect(at(40)).toEqual(HEX('#e34948'));     // the hot pole
    expect(at(-999)).toEqual(HEX('#2a78d6'));   // clamped
    expect(at(999)).toEqual(HEX('#e34948'));    // clamped
  });

  it('actually moves with the season', () => {
    const t = oneTile({ t_mean_c: [0], t_swing_c: [30] });
    expect(temperatureLens.colorAt(t, 0, 0)).not.toEqual(
      temperatureLens.colorAt(t, 0, 365 / 4),  // a quarter-year on: peak swing
    );
  });
});

describe('the moisture lens', () => {
  it('never calls itself rainfall', () => {
    expect(moistureLens.label).not.toMatch(/rain/i);
    expect(moistureLens.caption).toMatch(/index/i);
    expect(moistureLens.caption).toMatch(/not rainfall/i);
  });
  it('ramps dry→wet across the blue ramp', () => {
    const at = (m: number) => moistureLens.colorAt(oneTile({ moisture: [m] }), 0, 0);
    expect(at(0)).toEqual(HEX('#cde2fb'));
    expect(at(1)).toEqual(HEX('#0d366b'));
  });
});

describe('the unrest lens', () => {
  it('ramps calm→violent across the aqua ramp', () => {
    const at = (u: number) => unrestLens.colorAt(oneTile({ unrest: [u] }), 0, 0);
    expect(at(0)).toEqual(HEX('#d4f0e4'));
    expect(at(1)).toEqual(HEX('#0a4a33'));
  });

  it('discloses that the field is an approximated static snapshot', () => {
    // The producer's terrain model card declares unrest derived-and-
    // approximated: classified from instantaneous plate motion, with no
    // accumulated stress history. Rendering that as a bare fact is what the
    // caption discipline exists to prevent.
    expect(unrestLens.caption).toMatch(/snapshot/i);
    expect(unrestLens.caption).toMatch(/not a simulation/i);
  });
});

describe('the topographic lens', () => {
  it('shades land and sea alike through the hypsometric ramp', () => {
    for (const e of [-6000, -100, 0, 800, 2500, 5000]) {
      expect(topographicLens.colorAt(oneTile({ elevation_m: [e] }), 0, 0)).toEqual(
        elevationColor(e, 0),
      );
    }
  });
});
