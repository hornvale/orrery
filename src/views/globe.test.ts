import { expect, test } from 'vitest';
import * as THREE from 'three';
import {
  GLOBE_RADIUS,
  MARKER_CLEARANCE,
  RELIEF_EXAGGERATION,
  clusterFeatures,
  createGlobeView,
  onNearSide,
  sampleTile,
  subsolarPoint,
  tileIndexOfVertex,
} from './globe';
import { REFERENCE_RADIUS_M } from './worldMesh';
import type { SystemScene, TilesScene } from '../sim/scene';
import { loadSeed42Tiles, loadSeed42System } from '../testHelpers/wasmFixture';
import { moistureLens, naturalLens, temperatureLens } from './lens';

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
    t_mean_c: Array(n).fill(15), t_swing_c: Array(n).fill(5),
    season_period_days: 365, circulationBands: null, moisture: Array(n).fill(0.5),
    plate: Array(n).fill(0), unrest: Array(n).fill(0),
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

test('onNearSide admits markers up to the limb and rejects the far side', () => {
  const cam = new THREE.Vector3(0, 0, 6); // r/d = 1/3 → horizon ≈ 70.5°
  const at = (thetaDeg: number) => {
    const t = (thetaDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(t), 0, Math.cos(t));
  };
  expect(onNearSide(at(0), cam, 2)).toBe(true);
  expect(onNearSide(at(60), cam, 2)).toBe(true);
  expect(onNearSide(at(90), cam, 2)).toBe(false); // past the ≈70.5° horizon
  expect(onNearSide(at(180), cam, 2)).toBe(false);
});

test('labels stay hidden until their site is selected', () => {
  const tiles = markerTiles([
    { name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 10 },
    { name: 'Beta', kind: 'settlement', latitude: 5, longitude: 40 },
  ]);
  const view = createGlobeView(tiles, spinningSys());
  const labelOf = (name: string) =>
    view.object3d.getObjectByName(`feature-${name}`)!.children.find((c) => (c as THREE.Sprite).isSprite)! as THREE.Sprite;
  const dotOf = (name: string) =>
    view.object3d.getObjectByName(`feature-${name}`)!.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  view.object3d.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 100);
  camera.position.copy(dotOf('Alpha').getWorldPosition(new THREE.Vector3()).normalize().multiplyScalar(6));
  camera.lookAt(0, 0, 0);
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(false);
  expect(labelOf('Beta').visible).toBe(false);
  view.setSelected('Alpha');
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(true);
  expect(labelOf('Beta').visible).toBe(false);
  view.setSelected(null);
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(false);
});

test('update(day, camera) hides far-side markers and shows near ones', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 45 }]);
  const view = createGlobeView(tiles, spinningSys());
  const group = view.object3d.getObjectByName('feature-Alpha')!;
  const dot = group.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  view.object3d.updateMatrixWorld(true);
  const facing = dot.getWorldPosition(new THREE.Vector3()).normalize().multiplyScalar(6);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(facing);
  view.update(0, camera);
  expect(dot.visible).toBe(true);
  camera.position.copy(facing).negate();
  view.update(0, camera);
  expect(dot.visible).toBe(false);
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

/** Face 0's color attribute, copied (the buffer is mutated in place). */
function faceColors(globe: ReturnType<typeof createGlobeView>): Float32Array {
  const mesh = globe.object3d.getObjectByName('globe-face-0') as THREE.Mesh;
  return Float32Array.from(mesh.geometry.getAttribute('color').array as ArrayLike<number>);
}

async function makeGlobe() {
  return createGlobeView(await loadSeed42Tiles(64), await loadSeed42System());
}

// These four tests each instantiate the vendored wasm binary twice
// (tiles + system) via `makeGlobe`/`loadSeed42*`, roughly double any other
// single-fixture test in this suite. In isolation that is comfortably under
// vitest's 5s default, but under the full `npm test` run's file-level
// parallelism it reliably tips past it — an explicit timeout, not a slower
// or flakier test.
const WASM_FIXTURE_TIMEOUT_MS = 20000;

test('repaints when the lens changes', async () => {
  const globe = await makeGlobe();
  globe.update(0);
  const before = faceColors(globe);
  globe.setLens(temperatureLens);
  expect(faceColors(globe)).not.toEqual(before);
}, WASM_FIXTURE_TIMEOUT_MS);

test('advances the living lens with the clock', async () => {
  const globe = await makeGlobe();
  globe.setLens(temperatureLens);
  globe.update(0);
  const winter = faceColors(globe);
  globe.update(180); // roughly half a year on
  expect(faceColors(globe)).not.toEqual(winter);
}, WASM_FIXTURE_TIMEOUT_MS);

test('leaves a static lens alone as the clock runs', async () => {
  const globe = await makeGlobe();
  globe.setLens(moistureLens);
  globe.update(0);
  const day0 = faceColors(globe);
  globe.update(180);
  expect(faceColors(globe)).toEqual(day0);
}, WASM_FIXTURE_TIMEOUT_MS);

test('blends ice under natural and never under a data lens', async () => {
  const tiles = await loadSeed42Tiles(64);
  const globe = createGlobeView(tiles, await loadSeed42System());

  // Under a data lens every vertex is exactly its lens color — no ice blend.
  globe.setLens(moistureLens);
  globe.update(0);
  const data = faceColors(globe);
  const idx = /* the same tile index the recolor used */ 0;
  const expected = moistureLens.colorAt(tiles, tileIndexOfVertex(tiles, 0, idx), 0);
  expect(data[0]).toBeCloseTo(expected[0] / 255, 5);

  // Under natural, at least one vertex differs from the raw natural color —
  // that difference IS the ice blend. (Seed 42 has polar ice.)
  globe.setLens(naturalLens);
  globe.update(0);
  const natural = faceColors(globe);
  expect(natural).not.toEqual(data);
}, WASM_FIXTURE_TIMEOUT_MS);

test('the globe carries an ocean layer that follows the relief toggle', () => {
  // markerTiles is all land — give the west half sea so the ocean mounts.
  const tiles = markerTiles([]);
  tiles.sea_level_m = -2500;
  tiles.elevation_m = [-2600, -2600, -2000, -2000, -2600, -2600, -2000, -2000];
  tiles.ocean = [true, true, false, false, true, true, false, false];
  const view = createGlobeView(tiles, spinningSys());
  const ocean = view.object3d.getObjectByName('ocean')!;
  expect(ocean).toBeDefined();
  const mesh = ocean.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  const radiusOf = () => {
    const p = mesh.geometry.getAttribute('position');
    return Math.hypot(p.getX(0), p.getY(0), p.getZ(0));
  };
  const before = radiusOf();
  view.setTrueRelief(true);
  expect(radiusOf()).not.toBeCloseTo(before, 6);
  view.setTrueRelief(false);
  expect(radiusOf()).toBeCloseTo(before, 6);
});
