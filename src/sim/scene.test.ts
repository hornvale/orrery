import { describe, expect, it } from 'vitest';
import { parseSystem, parseTiles, parseRegion, parseMoons, parseNeighbors, SceneFormatError } from './scene';

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
  moons: [
    {
      sidereal_days: 16,
      phase_offset: 0.4,
      distance_mm: 384,
      size_rel: 1,
      inclination_deg: 117.277,
      node_longitude_deg: 12.5,
    },
  ],
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
    expect(s.moons[0]!.inclinationDeg).toEqual(117.277);
    expect(s.moons[0]!.nodeLongitudeDeg).toEqual(12.5);
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

  it('rejects a moon missing inclination_deg', () => {
    const doc = JSON.parse(DOC);
    delete doc.moons[0].inclination_deg;
    expect(() => parseSystem(JSON.stringify(doc))).toThrow('inclination_deg');
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

const MOONS_DOC = JSON.stringify({
  schema: 'scene/moons/v1',
  seed: 42,
  moons: [
    { index: 0, mass_rel: 1.2, radius_km: 1846.5, surface_gravity_ms2: 1.72,
      albedo: 0.18, cratering: 0.3, maria_fraction: 0.5, tint: [0.7, 0.68, 0.72],
      surface_class: 'maria-rich', density_g_cm3: 3.34, formation: 'giant-impact' },
    { index: 1, mass_rel: 0.4, radius_km: 1279.0, surface_gravity_ms2: 1.19,
      albedo: 0.22, cratering: 0.8, maria_fraction: 0.1, tint: [0.71, 0.7, 0.69],
      surface_class: 'heavily-cratered', density_g_cm3: 3.0, formation: 'capture' },
  ],
});

describe('parseMoons', () => {
  it('accepts a valid document and maps snake_case to camelCase', () => {
    const m = parseMoons(MOONS_DOC);
    expect(m.seed).toBe(42);
    expect(m.moons).toHaveLength(2);
    expect(m.moons[0]!.massRel).toBe(1.2);
    expect(m.moons[0]!.surfaceClass).toBe('maria-rich');
    expect(m.moons[1]!.tint).toEqual([0.71, 0.7, 0.69]);
    expect(m.moons[0]!.densityGCm3).toBe(3.34);
    expect(m.moons[0]!.formation).toBe('giant-impact');
    expect(m.moons[1]!.formation).toBe('capture');
  });
  it('rejects the wrong schema', () => {
    expect(() => parseMoons(JSON.stringify({ schema: 'scene/system/v1' }))).toThrow(SceneFormatError);
  });
  it('rejects a non-array moons', () => {
    expect(() => parseMoons(JSON.stringify({ schema: 'scene/moons/v1', seed: 1, moons: {} }))).toThrow('moons');
  });
  it('rejects a bad tint length', () => {
    const doc = JSON.parse(MOONS_DOC); doc.moons[0].tint = [0.7, 0.7];
    expect(() => parseMoons(JSON.stringify(doc))).toThrow('tint');
  });
  it('rejects a moons document without formation', () => {
    const doc = JSON.parse(MOONS_DOC); delete doc.moons[0].formation;
    expect(() => parseMoons(JSON.stringify(doc))).toThrow('formation');
  });
});

const NEIGHBORS_DOC = JSON.stringify({
  schema: 'scene/neighbors/v1',
  seed: 42,
  neighbors: [
    { index: 0, class_name: 'red giant', color: 'smoldering red', distance_ly: 12.5,
      brightness_rel: 4.2, ra_deg: 45.0, dec_deg: -12.3 },
    { index: 1, class_name: 'yellow dwarf (G)', color: 'warm gold', distance_ly: 30.1,
      brightness_rel: 1.1, ra_deg: 190.5, dec_deg: 60.0 },
  ],
  stars: [
    { ra_deg: 10.0, dec_deg: 5.0, magnitude_class: 1 },
    { ra_deg: 300.0, dec_deg: -45.0, magnitude_class: 5 },
  ],
});

describe('parseNeighbors', () => {
  it('accepts a valid document and maps snake_case to camelCase', () => {
    const n = parseNeighbors(NEIGHBORS_DOC);
    expect(n.schema).toBe('scene/neighbors/v1');
    expect(n.seed).toBe(42);
    expect(n.neighbors).toHaveLength(2);
    expect(n.stars).toHaveLength(2);
    expect(n.neighbors[0]).toEqual({
      index: 0,
      className: 'red giant',
      color: 'smoldering red',
      distanceLy: 12.5,
      brightnessRel: 4.2,
      raDeg: 45.0,
      decDeg: -12.3,
    });
    expect(n.stars[1]).toEqual({ raDeg: 300.0, decDeg: -45.0, magnitudeClass: 5 });
  });

  it('rejects the wrong schema', () => {
    expect(() => parseNeighbors(JSON.stringify({ schema: 'scene/neighbors/v0' }))).toThrow(SceneFormatError);
  });

  it('rejects a non-array stars', () => {
    const doc = JSON.parse(NEIGHBORS_DOC);
    doc.stars = 'not an array';
    expect(() => parseNeighbors(JSON.stringify(doc))).toThrow('stars');
  });

  it('rejects magnitude_class of 0', () => {
    const doc = JSON.parse(NEIGHBORS_DOC);
    doc.stars[0].magnitude_class = 0;
    expect(() => parseNeighbors(JSON.stringify(doc))).toThrow('magnitude_class');
  });

  it('rejects magnitude_class of 6', () => {
    const doc = JSON.parse(NEIGHBORS_DOC);
    doc.stars[0].magnitude_class = 6;
    expect(() => parseNeighbors(JSON.stringify(doc))).toThrow('magnitude_class');
  });

  it('rejects a dec_deg of 91', () => {
    const doc = JSON.parse(NEIGHBORS_DOC);
    doc.stars[0].dec_deg = 91;
    expect(() => parseNeighbors(JSON.stringify(doc))).toThrow('dec_deg');
  });
});
