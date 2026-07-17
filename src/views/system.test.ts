import { expect, test } from 'vitest';
import * as THREE from 'three';
import { createSystemView, orbitAngle, moonLocalPosition } from './system';
import { rotationPhase } from '../sim/ephemeris';
import type { MoonsScene, SystemScene, TilesScene } from '../sim/scene';

// Names adapted to the parsed (camelCase) SystemScene shape — the brief's
// sketch uses raw scene/system/v1 snake_case, but parseSystem in ./scene.ts
// is what every consumer actually sees.
const sys: SystemScene = {
  schema: 'scene/system/v1',
  seed: 42,
  star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.95, hzOuterAu: 1.4 },
  world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 20, yearPhaseOffset: 0.25 },
  moons: [{ siderealDays: 30, phaseOffset: 0, distanceMm: 384, sizeRel: 1, inclinationDeg: 0, nodeLongitudeDeg: 0 }],
};

test('orbitAngle honors the genesis phase offset', () => {
  // worldPhase(sys, 0) = 0.25 turns → angle π/2.
  expect(orbitAngle(sys, 0)).toBeCloseTo(Math.PI / 2, 10);
});

test('a moon returns to its position after one sidereal period', () => {
  const a = moonLocalPosition(sys, 0, 0);
  const b = moonLocalPosition(sys, 0, 30);
  expect(a.x).toBeCloseTo(b.x, 8);
  expect(a.z).toBeCloseTo(b.z, 8);
});

test('a moon is a quarter of the way around after a quarter sidereal period', () => {
  const start = moonLocalPosition(sys, 0, 0);
  const quarter = moonLocalPosition(sys, 0, 7.5);
  const r = Math.hypot(start.x, start.z);
  // 7.5/30 = 0.25 turn: (x, z) rotates from (r, 0) to (0, r).
  expect(quarter.x).toBeCloseTo(0, 8);
  expect(quarter.z).toBeCloseTo(r, 8);
});

/** A `MoonsScene` with one entry per `sys.moons` element — createSystemView
 * indexes `moons.moons` in lockstep with `sys.moons`. */
function oneMoonMoons(): MoonsScene {
  return {
    schema: 'scene/moons/v1',
    seed: 42,
    moons: [
      {
        index: 0, massRel: 1, radiusKm: 1737.4, surfaceGravityMs2: 1.62,
        albedo: 0.14, cratering: 0.3, mariaFraction: 0.5,
        tint: [0.7, 0.7, 0.7], surfaceClass: 'maria-rich',
        densityGCm3: 3.34, formation: 'giant-impact',
      },
    ],
  };
}

/** 4×2 all-land tiles — createSystemView only needs a valid lattice. */
function tinyTiles(): TilesScene {
  const n = 8;
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: Array(n).fill(0), ocean: Array(n).fill(false),
    biome: Array(n).fill(0), biomeLegend: ['steppe'], features: [],
    t_mean_c: Array(n).fill(15), t_swing_c: Array(n).fill(5),
    season_period_days: 365, circulationBands: null, moisture: Array(n).fill(0.5),
    plate: Array(n).fill(0), unrest: Array(n).fill(0),
  };
}

/** World-frame direction of the mesh's (lat 0, lon L) surface point. */
function meshLonDirection(view: ReturnType<typeof createSystemView>, lonRad: number): THREE.Vector3 {
  view.object3d.updateMatrixWorld(true);
  const spin = view.object3d.getObjectByName('world-spin')!;
  const local = new THREE.Vector3(Math.cos(lonRad), Math.sin(lonRad), 0);
  return local.transformDirection(spin.matrixWorld).normalize();
}

/** Direction from the world toward the star (at the origin) at `day`. */
function toStar(view: ReturnType<typeof createSystemView>, day: number): THREE.Vector3 {
  return view.worldPosition(day).negate().normalize();
}

test('a tidally locked world keeps longitude 0 facing the star all year', () => {
  const locked: SystemScene = {
    ...sys,
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: null, obliquityDeg: 0, yearPhaseOffset: 0.25 },
  };
  const view = createSystemView(locked, tinyTiles(), oneMoonMoons());
  for (const day of [0, 90, 137.5, 270]) {
    view.update(day);
    expect(meshLonDirection(view, 0).dot(toStar(view, day))).toBeCloseTo(1, 6);
  }
});

test("a spinning world's subsolar longitude matches the globe view's golden sweep", () => {
  const spinning: SystemScene = {
    ...sys,
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 0, yearPhaseOffset: 0.25 },
  };
  const view = createSystemView(spinning, tinyTiles(), oneMoonMoons());
  for (const day of [0, 0.3, 42.75, 200.5]) {
    view.update(day);
    // The globe view pins the light at azimuth 0 and spins the ground by
    // rotationPhase, so the subsolar longitude is -rotationPhase·TAU.
    const subsolarLon = -rotationPhase(spinning, day) * 2 * Math.PI;
    expect(meshLonDirection(view, subsolarLon).dot(toStar(view, day))).toBeCloseTo(1, 6);
  }
});

test('the pole stands out of the orbit plane, leaning by the obliquity, without precessing', () => {
  const view = createSystemView(sys, tinyTiles(), oneMoonMoons()); // obliquityDeg 20
  const poleAt = (day: number) => {
    view.update(day);
    view.object3d.updateMatrixWorld(true);
    const spin = view.object3d.getObjectByName('world-spin')!;
    return new THREE.Vector3(0, 0, 1).transformDirection(spin.matrixWorld).normalize();
  };
  const pole = poleAt(0);
  expect(pole.y).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 6);
  const later = poleAt(123.4);
  expect(later.distanceTo(pole)).toBeLessThan(1e-6);
});

test('two moons at the same day sit on different rungs of the radial ladder', () => {
  const twoMoonSys: SystemScene = {
    ...sys,
    moons: [
      { siderealDays: 30, phaseOffset: 0, distanceMm: 384, sizeRel: 1, inclinationDeg: 0, nodeLongitudeDeg: 0 },
      { siderealDays: 45, phaseOffset: 0, distanceMm: 900, sizeRel: 0.5, inclinationDeg: 0, nodeLongitudeDeg: 0 },
    ],
  };
  const m0 = moonLocalPosition(twoMoonSys, 0, 0);
  const m1 = moonLocalPosition(twoMoonSys, 1, 0);
  const r0 = Math.hypot(m0.x, m0.z);
  const r1 = Math.hypot(m1.x, m1.z);
  expect(r1).toBeGreaterThan(r0);
});
