import { describe, expect, it } from 'vitest';
import { parseSystem, parseTiles, parseRegion, parseMoons, parseNeighbors, parseEclipses, SceneFormatError } from './scene';

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
    t_diurnal_amp_c: Array(tiles).fill(8.0),
    current_east: Array(tiles).fill(0.1),
    current_north: Array(tiles).fill(-0.05),
    season_period_days: 365.25,
    circulation_bands: 3,
    moisture: Array(tiles).fill(0.5),
    plate: Array.from({ length: tiles }, (_, i) => i % 4),
    unrest: Array.from({ length: tiles }, (_, i) => (i % 5) / 4),
    locked: false,
    precip_mm_yr: Array(tiles).fill(800.0),
    snow_fraction: Array(tiles).fill(0.2),
    precip_regime: Array.from({ length: tiles }, (_, i) => i % 4),
    cloud_fraction: Array(tiles).fill(0.4),
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
    expect(t.tDiurnalAmpC.length).toEqual(128);
    expect(t.moisture.length).toEqual(128);
    expect(t.season_period_days).toEqual(365.25);
    expect(t.circulationBands).toEqual(3);
  });

  it('rejects a t_diurnal_amp_c whose length disagrees with the lattice', () => {
    const doc = validTiles();
    (doc.t_diurnal_amp_c as number[]).pop();
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('t_diurnal_amp_c');
  });

  it('rejects a document missing t_diurnal_amp_c', () => {
    const doc = validTiles();
    delete doc.t_diurnal_amp_c;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('t_diurnal_amp_c');
  });

  it('reads current_east/current_north onto currentEast/currentNorth', () => {
    const t = parseTiles(JSON.stringify(validTiles()));
    expect(t.currentEast.length).toEqual(128);
    expect(t.currentNorth.length).toEqual(128);
    expect(t.currentEast[0]).toEqual(0.1);
    expect(t.currentNorth[0]).toEqual(-0.05);
  });

  it('rejects a current_east whose length disagrees with the lattice', () => {
    const doc = validTiles();
    (doc.current_east as number[]).pop();
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('current_east');
  });

  it('rejects a document missing current_east', () => {
    const doc = validTiles();
    delete doc.current_east;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('current_east');
  });

  it('rejects a current_north whose length disagrees with the lattice', () => {
    const doc = validTiles();
    (doc.current_north as number[]).pop();
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('current_north');
  });

  it('rejects a document missing current_north', () => {
    const doc = validTiles();
    delete doc.current_north;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('current_north');
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

  it('rejects a document missing locked', () => {
    const doc = validTiles();
    delete doc.locked;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('locked');
  });

  it('round-trips locked: true and locked: false', () => {
    const lockedDoc = validTiles();
    lockedDoc.locked = true;
    expect(parseTiles(JSON.stringify(lockedDoc)).locked).toBe(true);

    const spinningDoc = validTiles();
    spinningDoc.locked = false;
    expect(parseTiles(JSON.stringify(spinningDoc)).locked).toBe(false);
  });

  it('reads precip_mm_yr/snow_fraction/precip_regime/cloud_fraction onto camelCase names', () => {
    const t = parseTiles(JSON.stringify(validTiles()));
    expect(t.precipMmYr.length).toEqual(128);
    expect(t.snowFraction.length).toEqual(128);
    expect(t.precipRegime.length).toEqual(128);
    expect(t.cloudFraction.length).toEqual(128);
    expect(t.precipMmYr[0]).toEqual(800.0);
    expect(t.snowFraction[0]).toEqual(0.2);
    expect(t.cloudFraction[0]).toEqual(0.4);
  });

  it('accepts every valid precip_regime index (0-3)', () => {
    const doc = validTiles();
    (doc.precip_regime as number[]) = Array.from({ length: 128 }, (_, i) => i % 4);
    const t = parseTiles(JSON.stringify(doc));
    expect(t.precipRegime.every((r) => r >= 0 && r <= 3)).toBe(true);
    expect(new Set(t.precipRegime)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('rejects a precip_regime index of 4 (out of the 4-variant range)', () => {
    const doc = validTiles();
    (doc.precip_regime as number[])[0] = 4;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('precip_regime');
  });

  it('rejects a non-integer precip_regime entry', () => {
    const doc = validTiles();
    (doc.precip_regime as number[])[0] = 1.5;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('precip_regime');
  });

  it('rejects a mismatched precip_mm_yr length', () => {
    const doc = validTiles();
    (doc.precip_mm_yr as number[]).pop();
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('precip_mm_yr');
  });

  it('rejects a document missing snow_fraction', () => {
    const doc = validTiles();
    delete doc.snow_fraction;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('snow_fraction');
  });

  it('rejects a document missing cloud_fraction', () => {
    const doc = validTiles();
    delete doc.cloud_fraction;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('cloud_fraction');
  });

  it('rejects a document missing precip_regime', () => {
    const doc = validTiles();
    delete doc.precip_regime;
    expect(() => parseTiles(JSON.stringify(doc))).toThrow('precip_regime');
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

function validEclipses(): Record<string, unknown> {
  return {
    schema: 'scene/eclipses/v1',
    seed: 42,
    from_day: 0,
    until_day: 2000,
    events: [
      {
        day: 85.982974,
        moon_index: 0,
        body: 'solar',
        kind: 'total',
        track: {
          center_lat_deg: 82.494963,
          half_width_deg: 2.0,
          start_lon_deg: -32.693882,
          end_lon_deg: -58.835236,
          duration_days: 0.063892372,
        },
      },
      {
        day: 94.34317,
        moon_index: 0,
        body: 'lunar',
        kind: 'total',
        track: null,
      },
    ],
  };
}

describe('parseEclipses', () => {
  it('reads a valid document and maps snake_case to camelCase', () => {
    const ecl = parseEclipses(JSON.stringify(validEclipses()));
    expect(ecl.schema).toBe('scene/eclipses/v1');
    expect(ecl.seed).toBe(42);
    expect(ecl.fromDay).toBe(0);
    expect(ecl.untilDay).toBe(2000);
    expect(ecl.events).toHaveLength(2);
  });

  it('rejects the wrong schema', () => {
    const doc = validEclipses();
    doc.schema = 'scene/eclipses/v0';
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow(SceneFormatError);
  });

  it('rejects events that are not an array', () => {
    const doc = validEclipses();
    doc.events = 'not an array';
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('events');
  });

  it("parses a solar event's track into camelCase", () => {
    const ecl = parseEclipses(JSON.stringify(validEclipses()));
    const solar = ecl.events[0]!;
    expect(solar.body).toBe('solar');
    expect(solar.track).toEqual({
      centerLatDeg: 82.494963,
      halfWidthDeg: 2.0,
      startLonDeg: -32.693882,
      endLonDeg: -58.835236,
      durationDays: 0.063892372,
    });
  });

  it("leaves a lunar event's track as null", () => {
    const ecl = parseEclipses(JSON.stringify(validEclipses()));
    const lunar = ecl.events[1]!;
    expect(lunar.body).toBe('lunar');
    expect(lunar.track).toBeNull();
  });

  it('rejects an invalid body', () => {
    const doc = validEclipses();
    (doc.events as Record<string, unknown>[])[0]!.body = 'partial';
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('body');
  });

  it('rejects an invalid kind', () => {
    const doc = validEclipses();
    (doc.events as Record<string, unknown>[])[0]!.kind = 'partial';
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('kind');
  });

  it('rejects a solar event with a null track', () => {
    const doc = validEclipses();
    (doc.events as Record<string, unknown>[])[0]!.track = null;
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('track');
  });

  it('rejects a lunar event with a non-null track', () => {
    const doc = validEclipses();
    (doc.events as Record<string, unknown>[])[1]!.track = (doc.events as Record<string, unknown>[])[0]!.track;
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('track');
  });

  it('rejects a centerLatDeg of 91', () => {
    const doc = validEclipses();
    (
      (doc.events as Record<string, unknown>[])[0]!.track as Record<string, unknown>
    ).center_lat_deg = 91;
    expect(() => parseEclipses(JSON.stringify(doc))).toThrow('center_lat_deg');
  });
});
