import { describe, expect, it } from 'vitest';
import { parseSystem, parseTiles, parseRegion, SceneFormatError } from './scene';

const DOC = JSON.stringify({
  schema: 'scene/system/v1',
  seed: 42,
  star: { class_name: 'yellow dwarf (G)', luminosity_rel: 1, hz_inner_au: 0.9, hz_outer_au: 1.4 },
  world: {
    orbit_au: 1,
    year_days: 372,
    day_length_days: 1,
    obliquity_deg: 23,
    year_phase_offset: 0.1,
  },
  moons: [{ sidereal_days: 16, phase_offset: 0.4, distance_mm: 384, size_rel: 1 }],
});

describe('parseSystem', () => {
  it('reads a valid document', () => {
    const s = parseSystem(DOC);
    expect(s.seed).toEqual(42);
    expect(s.moons.length).toEqual(1);
    expect(s.world.dayLengthDays).toEqual(1);
  });

  it('rejects the wrong schema', () => {
    expect(() => parseSystem(JSON.stringify({ schema: 'scene/tiles/v1' }))).toThrow(SceneFormatError);
  });

  it('maps snake_case fields to camelCase', () => {
    const s = parseSystem(DOC);
    expect(s.star.className).toEqual('yellow dwarf (G)');
    expect(s.star.luminosityRel).toEqual(1);
    expect(s.star.hzInnerAu).toEqual(0.9);
    expect(s.star.hzOuterAu).toEqual(1.4);
    expect(s.world.orbitAu).toEqual(1);
    expect(s.world.yearDays).toEqual(372);
    expect(s.world.obliquityDeg).toEqual(23);
    expect(s.world.yearPhaseOffset).toEqual(0.1);
    expect(s.moons[0]!.siderealDays).toEqual(16);
    expect(s.moons[0]!.phaseOffset).toEqual(0.4);
    expect(s.moons[0]!.distanceMm).toEqual(384);
    expect(s.moons[0]!.sizeRel).toEqual(1);
  });

  it('maps an absent day_length_days to null', () => {
    const doc = JSON.parse(DOC);
    delete doc.world.day_length_days;
    const s = parseSystem(JSON.stringify(doc));
    expect(s.world.dayLengthDays).toBeNull();
  });

  it('rejects a non-object document', () => {
    for (const text of ['null', '42', '[]', '"scene"']) {
      expect(() => parseSystem(text)).toThrow('object');
    }
  });

  it('rejects moons that are not an array', () => {
    const doc = JSON.parse(DOC);
    doc.moons = 'not an array';
    expect(() => parseSystem(JSON.stringify(doc))).toThrow('moons');
  });

  it('rejects a missing required field', () => {
    const doc = JSON.parse(DOC);
    delete doc.world.orbit_au;
    expect(() => parseSystem(JSON.stringify(doc))).toThrow('orbit_au');
  });

  // The Deno-era suite also checked the committed hornvale-book gallery
  // documents (scene-system-seed-42.json / scene-tiles-seed-42.json) parse.
  // Those live in the hornvale monorepo, not this standalone repo; Task 7's
  // wasm catalog loader will re-exercise this parser against real generated
  // documents once one exists here.
});

function validTiles(): Record<string, unknown> {
  const tiles = 16 * 8;
  return {
    schema: 'scene/tiles/v1',
    width: 16,
    height: 8,
    sea_level_m: 100.0,
    elevation_m: Array(tiles).fill(50.0),
    ocean: Array(tiles).fill(false),
    biome: Array(tiles).fill(0),
    biome_legend: ['temperate-forest'],
    features: [{ name: 'Anchorhold', kind: 'flagship', latitude: 12.5, longitude: -3.25 }],
    t_mean_c: Array(tiles).fill(15.0),
    t_swing_c: Array(tiles).fill(5.0),
    season_period_days: 365.25,
    circulation_bands: 3,
    moisture: Array(tiles).fill(0.5),
    plate: Array.from({ length: tiles }, (_, i) => i % 4),
    unrest: Array.from({ length: tiles }, (_, i) => (i % 5) / 4),
  };
}

describe('parseTiles', () => {
  it('reads a valid document', () => {
    const t = parseTiles(JSON.stringify(validTiles()));
    expect(t.width).toEqual(16);
    expect(t.height).toEqual(8);
    expect(t.elevation_m.length).toEqual(128);
  });

  it('rejects the wrong schema', () => {
    const doc = validTiles();
    doc.schema = 'scene/system/v1';
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('schema');
  });

  it('rejects height not equal to width / 2', () => {
    const doc = validTiles();
    doc.height = 9;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('height');
  });

  it('rejects a mismatched elevation_m length', () => {
    const doc = validTiles();
    (doc.elevation_m as number[]).push(1.0);
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('elevation_m');
  });

  it('maps ocean/biome/biome_legend/features onto camelCase names', () => {
    const t = parseTiles(JSON.stringify(validTiles()));
    expect(t.ocean.length).toEqual(128);
    expect(t.ocean.every((o) => o === false)).toBe(true);
    expect(t.biome.length).toEqual(128);
    expect(t.biomeLegend).toEqual(['temperate-forest']);
    expect(t.features).toEqual([{ name: 'Anchorhold', kind: 'flagship', latitude: 12.5, longitude: -3.25 }]);
  });

  it('rejects a mismatched ocean length', () => {
    const doc = validTiles();
    (doc.ocean as boolean[]).push(true);
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('ocean');
  });

  it('rejects a mismatched biome length', () => {
    const doc = validTiles();
    (doc.biome as number[]).push(0);
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('biome');
  });

  it('rejects features that are not an array', () => {
    const doc = validTiles();
    doc.features = 'not an array';
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('features');
  });

  it('rejects a feature missing a required field', () => {
    const doc = validTiles();
    doc.features = [{ name: 'Anchorhold', kind: 'flagship', latitude: 1 }];
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('longitude');
  });

  it('reads the climate layers with correct lengths', () => {
    const t = parseTiles(JSON.stringify(validTiles()));
    expect(t.t_mean_c.length).toEqual(128);
    expect(t.t_swing_c.length).toEqual(128);
    expect(t.moisture.length).toEqual(128);
    expect(t.season_period_days).toEqual(365.25);
    expect(t.circulationBands).toEqual(3);
  });

  it('treats an absent circulation_bands as null (locked world)', () => {
    const doc = validTiles();
    delete doc.circulation_bands;
    expect(parseTiles(JSON.stringify(doc)).circulationBands).toBeNull();
  });

  it('rejects a document missing a climate layer', () => {
    const doc = validTiles();
    delete doc.t_mean_c;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('t_mean_c');
  });

  it('rejects a t_swing_c whose length disagrees with the lattice', () => {
    const doc = validTiles();
    (doc.t_swing_c as number[]).pop();
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('t_swing_c');
  });

  it('parses the plate and unrest layers', () => {
    const doc = validTiles();
    const t = parseTiles(JSON.stringify(doc));
    expect(t.plate).toEqual(doc.plate);
    expect(t.unrest).toEqual(doc.unrest);
  });

  it('rejects a plate layer of the wrong length', () => {
    const doc = validTiles();
    doc.plate = [0, 1]; // not width × height
    expect(() => parseTiles(JSON.stringify(doc))).toThrow(SceneFormatError);
  });

  it('rejects a missing unrest layer', () => {
    const doc = validTiles();
    delete doc.unrest;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow(SceneFormatError);
  });
});

function validRegion(): Record<string, unknown> {
  // samples: 1 -> (1+1)^2 = 4 nodes.
  return {
    schema: 'scene/tiles-region/v1',
    seed: 42,
    face: 0,
    level: 3,
    ix: 4,
    iy: 4,
    samples: 1,
    sea_level_m: 100.0,
    season_period_days: 365.25,
    circulation_bands: 3,
    biome_legend: ['temperate-forest'],
    elevation_m: [10.0, 20.0, 30.0, 40.0],
    ocean: [false, false, true, false],
    biome: [0, 0, 0, 0],
    plate: [1, 1, 2, 2],
    unrest: [0.1, 0.2, 0.3, 0.4],
    t_mean_c: [15.0, 14.0, 13.0, 12.0],
    t_swing_c: [5.0, 5.0, 5.0, 5.0],
    moisture: [0.5, 0.5, 0.5, 0.5],
  };
}

describe('parseRegion', () => {
  it('reads a valid document', () => {
    const r = parseRegion(JSON.stringify(validRegion()));
    expect(r.schema).toEqual('scene/tiles-region/v1');
    expect(r.samples).toEqual(1);
    expect(r.elevation_m.length).toEqual(4);
    expect(r.t_mean_c.length).toEqual(4);
    expect(r.circulationBands).toEqual(3);
    expect(r.biomeLegend).toEqual(['temperate-forest']);
  });

  it('rejects the wrong schema', () => {
    const doc = validRegion();
    doc.schema = 'scene/tiles/v1';
    expect(() => parseRegion(JSON.stringify(doc))).toThrow('schema');
  });

  it('rejects a mismatched array length', () => {
    const doc = validRegion();
    (doc.elevation_m as number[]).push(50.0);
    expect(() => parseRegion(JSON.stringify(doc))).toThrow('elevation_m');
  });

  it('rejects samples: 0', () => {
    const doc = validRegion();
    doc.samples = 0;
    expect(() => parseRegion(JSON.stringify(doc))).toThrow('samples');
  });

  it('treats an absent circulation_bands as null (locked world)', () => {
    const doc = validRegion();
    delete doc.circulation_bands;
    expect(parseRegion(JSON.stringify(doc)).circulationBands).toBeNull();
  });
});
