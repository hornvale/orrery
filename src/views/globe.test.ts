import { expect, test } from 'vitest';
import * as THREE from 'three';
import {
  GLOBE_RADIUS,
  MARKER_CLEARANCE,
  RELIEF_EXAGGERATION,
  clusterFeatures,
  createGlobeView,
  sampleTile,
  subsolarPoint,
} from './globe';
import { REFERENCE_RADIUS_M } from './worldMesh';
import type { SystemScene, TilesScene } from '../sim/scene';

test('sampleTile maps lat/lon to the row-major equirect lattice', () => {
  // 4×2 lattice: row 0 is lat +90..0, col 0 is lon -180.
  const tiles = { width: 4, height: 2, elevation_m: [0, 1, 2, 3, 4, 5, 6, 7] } as never;
  expect(sampleTile(tiles, 45, -180, 'elevation_m')).toBe(0);
  expect(sampleTile(tiles, -45, 90, 'elevation_m')).toBe(7);
});

test('sampleTile reads other per-tile layers by the same lattice', () => {
  const tiles = {
    width: 4,
    height: 2,
    ocean: [true, false, false, false, false, false, false, true],
    biome: [0, 1, 2, 3, 4, 5, 6, 7],
  } as never;
  expect(sampleTile(tiles, 45, -180, 'ocean')).toBe(true);
  expect(sampleTile(tiles, -45, 90, 'biome')).toBe(7);
});

test('sampleTile wraps longitude at the +180/-180 seam', () => {
  const tiles = { width: 4, height: 2, elevation_m: [0, 1, 2, 3, 4, 5, 6, 7] } as never;
  // lon 180 wraps to the same column as lon -180 (col 0).
  expect(sampleTile(tiles, 45, 180, 'elevation_m')).toBe(0);
});

test('subsolar latitude swings ±obliquity over the year', () => {
  // Adapted to the parsed (camelCase) SystemScene shape (see system.test.ts's
  // precedent) — the brief's sketch uses raw scene/system/v1 snake_case.
  const sys = {
    world: { obliquityDeg: 20, yearDays: 360, yearPhaseOffset: 0, dayLengthDays: 1 },
  } as never;
  const lats = [0, 90, 180, 270].map((d) => subsolarPoint(sys, d).lat);
  expect(Math.max(...lats)).toBeCloseTo(20, 5);
  expect(Math.min(...lats)).toBeCloseTo(-20, 5);
});

test('subsolar longitude sweeps a full turn per day_length_days for a spinning world', () => {
  const sys: SystemScene = {
    schema: 'scene/system/v1',
    seed: 1,
    star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.9, hzOuterAu: 1.4 },
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 20, yearPhaseOffset: 0 },
    moons: [],
  };
  const a = subsolarPoint(sys, 0).lon;
  const b = subsolarPoint(sys, 1).lon;
  // A full day_length_days later, the sub-solar point has swept exactly one
  // full turn and returns to the same longitude.
  expect(b).toBeCloseTo(a, 8);
  const quarter = subsolarPoint(sys, 0.25).lon;
  expect(quarter).not.toBeCloseTo(a, 3);
});

/** Minimal spinning system for createGlobeView. */
function spinningSys(): SystemScene {
  return {
    schema: 'scene/system/v1',
    seed: 1,
    star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.9, hzOuterAu: 1.4 },
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 20, yearPhaseOffset: 0 },
    moons: [],
  };
}

/** 4×2 all-land world at a uniform 1000 m, with `features`. */
function markerTiles(features: TilesScene['features']): TilesScene {
  const n = 8;
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: Array(n).fill(1000), ocean: Array(n).fill(false),
    biome: Array(n).fill(0), biomeLegend: ['steppe'], features,
  };
}

test('clusterFeatures groups exact co-located features, flagship first', () => {
  const sites = clusterFeatures([
    { name: 'Alpha', kind: 'settlement', latitude: 10, longitude: 20 },
    { name: 'Beta', kind: 'settlement', latitude: -5, longitude: 60 },
    { name: 'Gamma', kind: 'settlement', latitude: 10, longitude: 20 },
    { name: 'Home', kind: 'flagship', latitude: 10, longitude: 20 },
  ]);
  expect(sites.length).toBe(2);
  const shared = sites.find((s) => s.latitude === 10)!;
  expect(shared.names).toEqual(['Home', 'Alpha', 'Gamma']);
  expect(shared.hasFlagship).toBe(true);
  expect(sites.find((s) => s.latitude === -5)!.names).toEqual(['Beta']);
});

test('marker dots sit on the displaced terrain, in both relief modes', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 45, longitude: 10 }]);
  const view = createGlobeView(tiles, spinningSys());
  const group = view.object3d.getObjectByName('feature-Alpha')!;
  const dot = group.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  const surface = (scale: number) => GLOBE_RADIUS * (1 + (scale * 1000) / REFERENCE_RADIUS_M);
  const clearance = GLOBE_RADIUS * MARKER_CLEARANCE;
  expect(dot.position.length()).toBeCloseTo(surface(RELIEF_EXAGGERATION) + clearance, 6);
  view.setTrueRelief(true);
  expect(dot.position.length()).toBeCloseTo(surface(1) + clearance, 6);
  view.setTrueRelief(false);
  expect(dot.position.length()).toBeCloseTo(surface(RELIEF_EXAGGERATION) + clearance, 6);
});

test('co-located features build one marker group, named for the flagship', () => {
  const tiles = markerTiles([
    { name: 'Alpha', kind: 'settlement', latitude: 45, longitude: 10 },
    { name: 'Home', kind: 'flagship', latitude: 45, longitude: 10 },
  ]);
  const view = createGlobeView(tiles, spinningSys());
  const groups: THREE.Object3D[] = [];
  view.object3d.traverse((o) => {
    if (o.name.startsWith('feature-')) groups.push(o);
  });
  expect(groups.length).toBe(1);
  expect(groups[0]!.name).toBe('feature-Home');
});

test('subsolar longitude is frozen for a tidally locked world', () => {
  const sys: SystemScene = {
    schema: 'scene/system/v1',
    seed: 1,
    star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.9, hzOuterAu: 1.4 },
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: null, obliquityDeg: 20, yearPhaseOffset: 0 },
    moons: [],
  };
  expect(subsolarPoint(sys, 0).lon).toBe(0);
  expect(subsolarPoint(sys, 123).lon).toBe(0);
});
