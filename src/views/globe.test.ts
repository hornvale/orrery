import { beforeAll, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  GLOBE_RADIUS,
  MARKER_CLEARANCE,
  RELIEF_EXAGGERATION,
  clusterFeatures,
  createGlobeView,
  onNearSide,
  sampleTile,
  seasonalSpinZ,
  subsolarPoint,
  tileIndexOfVertex,
} from './globe';
import { REFERENCE_RADIUS_M } from './worldMesh';
import { TILE_QUADS } from './cubeSphere';
import { iceFraction } from './ice';
import { rotationPhase } from '../sim/ephemeris';
import type { SystemScene, TilesScene } from '../sim/scene';
import { loadSeed42Tiles, loadSeed42System } from '../testHelpers/wasmFixture';
import { moistureLens, naturalLens, temperatureLens } from './lens';

const TAU = Math.PI * 2;

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

test('seasonalSpinZ freezes the spin at a fixed reference regardless of day when hold is on', () => {
  const sys = spinningSys();
  // Fractional days: dayLengthDays is 1 here, so integer days would land on
  // the same phase even unfrozen and mask a mutation that ignored `hold`.
  expect(seasonalSpinZ(sys, 10.3, true)).toBe(0);
  expect(seasonalSpinZ(sys, 10.3, true)).toBe(seasonalSpinZ(sys, 200.7, true));
  // Confirms this isn't a coincidence of the chosen days: the unfrozen spin
  // at the same days actually differs from the frozen 0.
  expect(seasonalSpinZ(sys, 10.3, false)).not.toBe(0);
});

test('seasonalSpinZ reproduces today\'s spin when hold is off', () => {
  const sys = spinningSys();
  expect(seasonalSpinZ(sys, 10.3, false)).toBeCloseTo(rotationPhase(sys, 10.3) * TAU, 10);
  // dayLengthDays is 1 here, so integer days share a phase — compare
  // fractional days to actually observe the sweep.
  expect(seasonalSpinZ(sys, 10.3, false)).not.toBeCloseTo(seasonalSpinZ(sys, 200.7, false), 3);
});

test('sub-solar latitude keeps advancing with day independent of the spin freeze', () => {
  const sys = spinningSys();
  // subsolarPoint takes no hold parameter — its latitude term (obliquity ×
  // year phase) is untouched by seasonalSpinZ's freeze either way, which is
  // exactly what lets the season keep moving while the mesh holds still.
  expect(subsolarPoint(sys, 10).lat).not.toBeCloseTo(subsolarPoint(sys, 200).lat, 3);
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
    plate: Array(n).fill(0), unrest: Array(n).fill(0), locked: false,
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

test('setNightFill raises an ambient fill, off by default (honest dark terminator)', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 0 }]);
  const view = createGlobeView(tiles, spinningSys());
  let ambient: THREE.AmbientLight | null = null;
  view.object3d.traverse((o) => {
    if ((o as THREE.AmbientLight).isAmbientLight) ambient = o as THREE.AmbientLight;
  });
  const amb = ambient as THREE.AmbientLight | null;
  expect(amb).not.toBeNull();
  expect(amb!.intensity).toBe(0); // default: night side falls to dark
  view.setNightFill(true);
  expect(amb!.intensity).toBeGreaterThan(0);
  view.setNightFill(false);
  expect(amb!.intensity).toBe(0);
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

test('setSeasonalHold(true) freezes globe-spin rotation across days', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  view.setSeasonalHold(true);
  // Fractional days: dayLengthDays is 1 here, so integer days would land on
  // the same phase even unfrozen and mask a mutation that ignored the hold.
  view.update(10.3);
  const spin = view.object3d.getObjectByName('globe-spin')!;
  const rotAt10 = spin.rotation.z;
  view.update(200.7);
  const rotAt200 = spin.rotation.z;
  expect(rotAt10).toBe(0);
  expect(rotAt10).toBe(rotAt200);
});

test('setSeasonalHold(false) (the default) leaves the spin advancing with day, as today', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  // dayLengthDays is 1 for spinningSys(), so integer days all land on the
  // same phase — use fractional days so the sweep is actually observed.
  view.update(10.3);
  const spin = view.object3d.getObjectByName('globe-spin')!;
  const rotAt10 = spin.rotation.z;
  view.update(200.7);
  const rotAt200 = spin.rotation.z;
  expect(rotAt10).not.toBeCloseTo(rotAt200, 3);
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

// `loadSeed42Tiles`/`loadSeed42System` memoize per-argument (wasmFixture.ts),
// so every call below already shared one wasm instantiation each within this
// file; `beforeAll` gives that one real cost (seconds, not vitest's 5s
// default) a single predictable home in a hook with its own timeout, instead
// of paying it inline in whichever test happens to run first. Every test
// below now just reads the file-scoped fixtures, so none needs an elevated
// per-test timeout.
// This file needs two sequential loads (tiles + system), each independently
// observed in the 15-30s range under full-suite contention — a 30s hook
// timeout was measured to be too tight (it fired once), so this one gets
// double the headroom of the single-load files below.
let seed42Tiles: TilesScene;
let seed42System: SystemScene;
beforeAll(async () => {
  seed42Tiles = await loadSeed42Tiles(64);
  seed42System = await loadSeed42System();
}, 60000);

function makeGlobe() {
  return createGlobeView(seed42Tiles, seed42System);
}

test('repaints when the lens changes', () => {
  const globe = makeGlobe();
  globe.update(0);
  const before = faceColors(globe);
  globe.setLens(temperatureLens);
  expect(faceColors(globe)).not.toEqual(before);
});

test('advances the living lens with the clock', () => {
  const globe = makeGlobe();
  globe.setLens(temperatureLens);
  globe.update(0);
  const winter = faceColors(globe);
  globe.update(180); // roughly half a year on
  expect(faceColors(globe)).not.toEqual(winter);
});

test('leaves a static lens alone as the clock runs', () => {
  const globe = makeGlobe();
  globe.setLens(moistureLens);
  globe.update(0);
  const day0 = faceColors(globe);
  globe.update(180);
  expect(faceColors(globe)).toEqual(day0);
});

test('blends ice under natural and never under a data lens', () => {
  const tiles = seed42Tiles;
  const globe = createGlobeView(tiles, seed42System);

  // Under a data lens every vertex is exactly its lens color — no ice blend.
  globe.setLens(moistureLens);
  globe.update(0);
  const data = faceColors(globe);
  const idx = /* the same tile index the recolor used */ 0;
  const expected = moistureLens.colorAt(tiles, tileIndexOfVertex(tiles, 0, idx), 0);
  expect(data[0]).toBeCloseTo(expected[0] / 255, 5);

  // Under natural, an icy vertex's painted color must differ from
  // naturalLens's own raw color at that tile — that difference IS the ice
  // blend. Find a genuinely icy vertex on face 0 (seed 42 has polar ice)
  // rather than assuming vertex 0 is one, so the assertion is pinned to the
  // blend itself and not incidentally satisfied by two lenses just painting
  // different data.
  globe.setLens(naturalLens);
  globe.update(0);
  const natural = faceColors(globe);
  const gridN = (TILE_QUADS + 1) * (TILE_QUADS + 1);
  let icyVertex = -1;
  for (let v = 0; v < gridN; v++) {
    if (iceFraction(tiles, tileIndexOfVertex(tiles, 0, v), 0) > 0) {
      icyVertex = v;
      break;
    }
  }
  expect(icyVertex).toBeGreaterThanOrEqual(0);
  const rawColor = naturalLens.colorAt(tiles, tileIndexOfVertex(tiles, 0, icyVertex), 0);
  expect(natural[3 * icyVertex]).not.toBeCloseTo(rawColor[0] / 255, 5);
});

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

test('water is visible under natural only — hidden under every data lens', () => {
  const tiles = markerTiles([]);
  tiles.sea_level_m = -2500;
  tiles.elevation_m = [-2600, -2600, -2000, -2000, -2600, -2600, -2000, -2000];
  tiles.ocean = [true, true, false, false, true, true, false, false];
  const view = createGlobeView(tiles, spinningSys());
  const ocean = view.object3d.getObjectByName('ocean')!;
  // The globe starts on `natural` — water visible from the first frame.
  expect(ocean.visible).toBe(true);
  view.setLens(moistureLens);
  expect(ocean.visible).toBe(false);
  view.setLens(naturalLens);
  expect(ocean.visible).toBe(true);
});
