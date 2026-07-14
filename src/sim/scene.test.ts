import { describe, expect, it } from 'vitest';
import { parseSystem, parseTiles, SceneFormatError } from './scene';

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
});
