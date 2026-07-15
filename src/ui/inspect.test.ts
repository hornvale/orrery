import { describe, expect, it } from 'vitest';
import { parseSystem } from '../sim/scene';
import type { TilesScene } from '../sim/scene';
import { moonPhase } from '../sim/ephemeris';
import { daysToNextFull, moonInfo, namedTarget, settlementInfo, starInfo, worldInfo } from './inspect';

// Inlined verbatim from src/sim/ephemeris.test.ts (the seed-42 golden
// system document) — same fixture, same numbers, one more consumer.
const sys = parseSystem(JSON.stringify({
  schema: 'scene/system/v1',
  seed: 42,
  star: { class_name: 'yellow dwarf (G)', luminosity_rel: 0.70079542, hz_inner_au: 0.79527848, hz_outer_au: 1.1468753 },
  world: {
    orbit_au: 0.97164647,
    year_days: 368.05357,
    day_length_days: 0.87987998,
    obliquity_deg: 0.95930567,
    year_phase_offset: 0.20941868,
  },
  moons: [
    { sidereal_days: 15.993805, phase_offset: 0.85759808, distance_mm: 307.74439, size_rel: 1.6350803 },
    { sidereal_days: 32.555, phase_offset: 0.25842259, distance_mm: 494.27358, size_rel: 0.69049995 },
  ],
}));

function tinyTiles(): TilesScene {
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: [5, -100, 5, 5, 5, 5, 5, 5], ocean: [false, true, false, false, false, false, false, false],
    biome: [0, 0, 0, 0, 0, 0, 0, 0], biomeLegend: ['steppe'],
    features: [{ name: 'Daoqao', kind: 'settlement', latitude: 60, longitude: -170 }],
  };
}

describe('inspector content', () => {
  it('a settlement card samples its own ground', () => {
    const card = settlementInfo(tinyTiles(), tinyTiles().features[0]!);
    expect(card.title).toBe('Daoqao');
    expect(card.kindLine).toBe('settlement');
    expect(card.lines.some((l) => l.includes('60.0°N'))).toBe(true);
    expect(card.lines.some((l) => l.includes('steppe'))).toBe(true);
  });
  it('altitude is relative to sea level, not the elevation datum', () => {
    // Real documents put sea level well below the datum's zero (seed 42:
    // sea_level_m ≈ -2582), so raw elevation_m reads negative on land.
    const tiles = { ...tinyTiles(), sea_level_m: -2500 };
    tiles.elevation_m = [-2000, -2600, 5, 5, 5, 5, 5, 5];
    const land = settlementInfo(tiles, { name: 'Daoqao', kind: 'settlement', latitude: 60, longitude: -170 });
    expect(land.lines.some((l) => l.includes('500 m above sea'))).toBe(true);
    const sea = settlementInfo(tiles, { name: 'Adrift', kind: 'settlement', latitude: 60, longitude: -80 });
    expect(sea.lines.some((l) => l.includes('ocean · 100 m deep'))).toBe(true);
  });
  it('days to next full lands on phase 0.5', () => {
    const dt = daysToNextFull(sys, 0, 10);
    expect(dt).not.toBeNull();
    expect(Math.abs(moonPhase(sys, 0, 10 + dt!) - 0.5)).toBeLessThan(1e-9);
  });
  it('star and world cards carry the document numbers', () => {
    expect(starInfo(sys).title.includes(sys.star.className)).toBe(true);
    expect(worldInfo(sys, 0).lines.some((l) => l.includes(`${sys.world.yearDays.toFixed(1)}`))).toBe(true);
  });
  it('maps object names to targets, walking prefixes', () => {
    expect(namedTarget('star')).toEqual({ kind: 'star' });
    expect(namedTarget('moon-2')).toEqual({ kind: 'moon', index: 2 });
    expect(namedTarget('feature-Daoqao')).toEqual({ kind: 'feature', name: 'Daoqao' });
    expect(namedTarget('globe-face-3')).toEqual({ kind: 'world' });
    expect(namedTarget('world-spin')).toEqual({ kind: 'world' });
    expect(namedTarget('starfield-or-whatever')).toBeNull();
  });
});
