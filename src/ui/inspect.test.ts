import { describe, expect, it } from 'vitest';
import { parseMoons, parseSystem } from '../sim/scene';
import type { EclipseEvent, TilesScene } from '../sim/scene';
import { moonPhase } from '../sim/ephemeris';
import {
  daysToNextFull,
  eclipseInfo,
  moonInfo,
  namedTarget,
  settlementInfo,
  siteInfo,
  starInfo,
  worldInfo,
} from './inspect';

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
    { sidereal_days: 15.993805, phase_offset: 0.85759808, distance_mm: 307.74439, size_rel: 1.6350803,
      inclination_deg: 3.5, node_longitude_deg: 40.0 },
    { sidereal_days: 32.555, phase_offset: 0.25842259, distance_mm: 494.27358, size_rel: 0.69049995,
      inclination_deg: 117.277, node_longitude_deg: 200.0 },
  ],
}));

// A scene/moons/v1 fixture matching sys's two moons — the physical
// descriptors moonInfo surfaces alongside the orbital elements above.
const moons = parseMoons(JSON.stringify({
  schema: 'scene/moons/v1',
  seed: 42,
  moons: [
    { index: 0, mass_rel: 0.31, radius_km: 903.2, surface_gravity_ms2: 1.42,
      albedo: 0.18, cratering: 0.3, maria_fraction: 0.5, tint: [0.7, 0.68, 0.72],
      surface_class: 'maria-rich', density_g_cm3: 3.34, formation: 'giant-impact' },
    { index: 1, mass_rel: 0.04, radius_km: 350.0, surface_gravity_ms2: 0.55,
      albedo: 0.32, cratering: 0.8, maria_fraction: 0.1, tint: [0.71, 0.7, 0.69],
      surface_class: 'heavily-cratered', density_g_cm3: 3.0, formation: 'capture' },
  ],
}));

function tinyTiles(): TilesScene {
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: [5, -100, 5, 5, 5, 5, 5, 5], ocean: [false, true, false, false, false, false, false, false],
    biome: [0, 0, 0, 0, 0, 0, 0, 0], biomeLegend: ['steppe'],
    features: [{ name: 'Daoqao', kind: 'settlement', latitude: 60, longitude: -170 }],
    t_mean_c: Array(8).fill(15), t_swing_c: Array(8).fill(5),
    season_period_days: 365, circulationBands: null, moisture: Array(8).fill(0.5),
    plate: Array(8).fill(0), unrest: Array(8).fill(0), locked: false,
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
  it('a lone feature makes siteInfo a plain settlement card', () => {
    const tiles = tinyTiles();
    expect(siteInfo(tiles, [tiles.features[0]!])).toEqual(settlementInfo(tiles, tiles.features[0]!));
  });
  it('co-located features share one card naming every resident', () => {
    const tiles = tinyTiles();
    const site = [
      { name: 'Home', kind: 'flagship', latitude: 60, longitude: -170 },
      { name: 'Alpha', kind: 'settlement', latitude: 60, longitude: -170 },
      { name: 'Beta', kind: 'settlement', latitude: 60, longitude: -170 },
    ];
    const card = siteInfo(tiles, site);
    expect(card.title).toBe('Home');
    expect(card.kindLine).toBe('flagship + 2 settlements');
    expect(card.lines.some((l) => l.includes('Alpha') && l.includes('Beta'))).toBe(true);
    // The shared ground sample still appears once.
    expect(card.lines.some((l) => l.includes('steppe'))).toBe(true);
  });
  it('a flagship-less site counts plainly', () => {
    const tiles = tinyTiles();
    const site = [
      { name: 'Alpha', kind: 'settlement', latitude: 60, longitude: -170 },
      { name: 'Beta', kind: 'settlement', latitude: 60, longitude: -170 },
    ];
    expect(siteInfo(tiles, site).kindLine).toBe('2 settlements');
  });
  it('days to next full lands on phase 0.5', () => {
    const dt = daysToNextFull(sys, 0, 10);
    expect(dt).not.toBeNull();
    expect(Math.abs(moonPhase(sys, 0, 10 + dt!) - 0.5)).toBeLessThan(1e-9);
  });
  it('the moon card wears its surface_class as flavor', () => {
    expect(moonInfo(sys, moons, 0, 10).kindLine).toBe('maria-rich moon');
    // Moon 1's inclination is 117.277° (> 90°) — retrograde-tagged below.
    expect(moonInfo(sys, moons, 1, 10).kindLine).toBe('retrograde heavily-cratered moon');
  });
  it('the moon card surfaces mass and radius from scene/moons/v1', () => {
    const card = moonInfo(sys, moons, 0, 10);
    expect(card.lines.some((l) => l.includes('mass ×0.31 luna'))).toBe(true);
    expect(card.lines.some((l) => l.includes('radius 903 km'))).toBe(true);
  });
  it('the moon card surfaces gravity with an Earth-g anchor', () => {
    // 1.42 / 9.81 ≈ 0.14
    const card = moonInfo(sys, moons, 0, 10);
    expect(card.lines.some((l) => l.includes('1.42 m/s') && l.includes('×0.14 Earth g'))).toBe(true);
  });
  it('the moon card surfaces albedo', () => {
    const card = moonInfo(sys, moons, 0, 10);
    expect(card.lines.some((l) => l.includes('albedo 0.18'))).toBe(true);
  });
  it('the moon card surfaces formation and density from scene/moons/v1', () => {
    const card = moonInfo(sys, moons, 0, 10);
    expect(card.lines.some((l) => l.includes('formed by giant-impact · density 3.34 g/cm³'))).toBe(true);
    const other = moonInfo(sys, moons, 1, 10);
    expect(other.lines.some((l) => l.includes('formed by capture · density 3.00 g/cm³'))).toBe(true);
  });
  it('a prograde moon (inclination 3.5°) carries no retrograde tag', () => {
    expect(moonInfo(sys, moons, 0, 10).kindLine).toBe('maria-rich moon');
  });
  it('a retrograde moon (inclination 117.277° > 90°) is tagged on the kind line', () => {
    expect(moonInfo(sys, moons, 1, 10).kindLine).toBe('retrograde heavily-cratered moon');
  });
  it('star and world cards carry the document numbers', () => {
    expect(starInfo(sys).title.includes(sys.star.className)).toBe(true);
    expect(worldInfo(sys, 0).lines.some((l) => l.includes(`${sys.world.yearDays.toFixed(1)}`))).toBe(true);
  });
  it("the world card speaks hornvale's vocabulary: obliquity", () => {
    expect(worldInfo(sys, 0).lines.some((l) => l.includes('obliquity'))).toBe(true);
  });
  it('names the body, kind, moon, and day on a solar-total eclipse card', () => {
    const event: EclipseEvent = {
      day: 184.5,
      moonIndex: 0,
      body: 'solar',
      kind: 'total',
      track: { centerLatDeg: 0, halfWidthDeg: 1.2, startLonDeg: -40, endLonDeg: 10, durationDays: 0.01 },
    };
    const card = eclipseInfo(event);
    expect(card.title.toLowerCase()).toContain('solar');
    expect(card.kindLine.toLowerCase()).toContain('total');
    expect(card.kindLine).toContain('0'); // moon index
    expect(card.lines.some((l) => l.includes('184.5'))).toBe(true);
  });
  it('names the body, kind, moon, and day on a lunar-annular eclipse card', () => {
    const event: EclipseEvent = { day: 40, moonIndex: 1, body: 'lunar', kind: 'annular', track: null };
    const card = eclipseInfo(event);
    expect(card.title.toLowerCase()).toContain('lunar');
    expect(card.kindLine.toLowerCase()).toContain('annular');
    expect(card.kindLine).toContain('1'); // moon index
    expect(card.lines.some((l) => l.includes('40'))).toBe(true);
  });
  it('maps object names to targets, walking prefixes', () => {
    expect(namedTarget('star')).toEqual({ kind: 'star' });
    expect(namedTarget('moon-2')).toEqual({ kind: 'moon', index: 2 });
    expect(namedTarget('feature-Daoqao')).toEqual({ kind: 'feature', name: 'Daoqao' });
    expect(namedTarget('globe-face-3')).toEqual({ kind: 'world' });
    expect(namedTarget('globe-tile-3:1:0:1')).toEqual({ kind: 'world' }); // LOD tile names
    expect(namedTarget('world-spin')).toEqual({ kind: 'world' });
    expect(namedTarget('starfield-or-whatever')).toBeNull();
  });
});
