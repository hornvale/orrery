/** The system view: star + habitable-zone band + orbit line + world + moons,
 * positioned entirely by the harvested golden-pinned ephemeris. This module
 * owns two kinds of surface: pure position math (`orbitAngle`,
 * `moonLocalPosition` — no WebGL, unit-tested directly) and the three.js
 * scene graph builder (`createSystemView`) that consumes it.
 *
 * Scale is deliberately schematic, not physical: one AU/HZ-band scale
 * governs the star-to-world orbit, but moon distances sit on a compressed
 * "radial ladder" (evenly spaced rungs by index) rather than true
 * `distanceMm` — a real moon orbit is millimetres from its world on the
 * same screen where the world's orbit is astronomical units. The caller is
 * expected to caption this (ORRERY-scale-honesty's lesson: admit the lie).
 */
import * as THREE from 'three';
import type { MoonsScene, NeighborsScene, SystemScene, TilesScene } from '../sim/scene';
import { rotationPhase, worldPhase } from '../sim/ephemeris';
import { starTint } from '../sim/palette';
import { buildFaceGeometry } from './worldMesh';
import { naturalLens } from './lens';
import { moonOrbitRadiusUnits, starRadiusUnits, worldRadiusUnits } from './scale';
import { moonBaseColor, moonRadiusUnitsFromKm } from './moonShading';
import { moonTexture } from './moonTexture';
import { buildRealStarfield } from './starfield';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Schematic world units per AU — governs the star's orbit line, the
 * world's orbit radius, and the HZ annulus. Must match `./scale.ts`'s
 * internal AU_SCALE. */
const AU_SCALE = 3;
const STAR_RADIUS = 0.35;
const WORLD_RADIUS = 0.12;
const ORBIT_SEGMENTS = 128;

/** The world's orbital angle (radians) around the star at `day`. The
 * golden-pinned `worldPhase` is the single source of angular truth for the
 * world's position — this only turns its [0,1) turns into radians. */
export function orbitAngle(sys: SystemScene, day: number): number {
  return worldPhase(sys, day) * TAU;
}

/** The world mesh's spin angle (radians about its own polar axis) at `day`.
 *
 * Not `rotationPhase` alone: this view's star is a real object in the
 * inertial frame, so the mesh's spin must compose the orbit angle with the
 * golden solar-day sweep for the *subsolar longitude* to match what the
 * globe view renders (`subsolarPoint`'s `-rotationPhase * 360`). The
 * payoff for a tidally locked world (rotationPhase 0): it rotates exactly
 * once per orbit, keeping longitude 0 starward forever — instead of a
 * frozen inertial orientation that shows the star sweeping the whole
 * surface once a year, a day the document says it doesn't have. */
export function worldSpinAngle(sys: SystemScene, day: number): number {
  return rotationPhase(sys, day) * TAU - orbitAngle(sys, day) - Math.PI;
}

/** Moon `i`'s own orbital-position phase in [0,1): a full turn every
 * `siderealDays`. Distinct from `moonPhase` (the sun-relative illumination
 * phase used to shade a disc, golden-pinned in ./ephemeris) — a moon's
 * position around its world cycles at its sidereal period, while its
 * illuminated fraction cycles at the (generally different) synodic period.
 * Placing the moon here and lighting it with a real point light at the
 * star gives correct-looking phases for free, without needing
 * `moonPhase`'s value at all. */
function moonOrbitalPhase(sys: SystemScene, i: number, day: number): number {
  const m = sys.moons[i]!;
  const t = day / m.siderealDays + m.phaseOffset;
  return t - Math.floor(t);
}

/** Moon `i`'s position (world units, in the world's local frame) at `day`,
 * on the schematic radial ladder, or (if `trueScale`) at its true
 * `distanceMm` through the same AU scale as the world's orbit. The flat
 * circular position is tilted about the ascending-node axis by
 * `inclinationDeg` — 0 reproduces the untilted circle exactly (an
 * axis-angle rotation by 0 radians is the identity), while inclinations
 * past 90° (e.g. a captured retrograde moon) sweep the opposite way once
 * projected back onto the xz plane. */
export function moonLocalPosition(
  sys: SystemScene,
  i: number,
  day: number,
  trueScale = false,
): THREE.Vector3 {
  const m = sys.moons[i]!;
  const angle = moonOrbitalPhase(sys, i, day) * TAU;
  const radius = moonOrbitRadiusUnits(i, m.distanceMm, trueScale);
  const v = new THREE.Vector3(radius * Math.cos(angle), 0, radius * Math.sin(angle));
  const node = m.nodeLongitudeDeg * DEG;
  const nodeAxis = new THREE.Vector3(Math.cos(node), 0, Math.sin(node));
  return v.applyAxisAngle(nodeAxis, m.inclinationDeg * DEG);
}

/** The system view's public surface: a mountable object graph plus the two
 * things a driver (the HUD scrubber, Task 10's zoom) needs. */
export interface SystemView {
  /** The whole system's root node — mount this once into a THREE.Scene. */
  object3d: THREE.Object3D;
  /** Repositions the world and its moons for `day`; call every frame. */
  update(day: number): void;
  /** The world's position (world units, system-root-local) at `day`,
   * without mutating anything — Task 10's zoom target. */
  worldPosition(day: number): THREE.Vector3;
  /** Toggle schematic (rung-ladder, exaggerated radii) vs true scale —
   * repositions rungs and rescales bodies; positions update next frame. */
  setTrueScale(on: boolean): void;
}

function buildOrbitLine(radiusUnits: number): THREE.LineLoop {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < ORBIT_SEGMENTS; i++) {
    const a = (i / ORBIT_SEGMENTS) * TAU;
    points.push(new THREE.Vector3(radiusUnits * Math.cos(a), 0, radiusUnits * Math.sin(a)));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color: 0x4a5578 }));
}

/** Build the system's three.js scene graph: star sphere tinted by spectral
 * class, an HZ annulus, the world's orbit line, the world itself (six
 * cube-sphere faces wearing the real tile colors, spun by rotationPhase),
 * and its moons — all positioned by `update(day)` from the golden-pinned
 * ephemeris. `moons` (`scene/moons/v1`, parsed) supplies each moon sphere's
 * shading and physical size (`../views/moonShading.ts`); its `moons` array
 * is indexed in lockstep with `sys.moons` (both come from the same
 * catalog's genesis, in the same per-moon order). `neighbors`
 * (`scene/neighbors/v1`, parsed) supplies the real night sky — the world's
 * drawn neighbor stars plus its derived background field
 * (`./starfield.ts`) — replacing the earlier cosmetic random point cloud. */
export function createSystemView(
  sys: SystemScene,
  tiles: TilesScene,
  moons: MoonsScene,
  neighbors: NeighborsScene,
): SystemView {
  const root = new THREE.Object3D();
  root.name = 'system-root';

  const [r, g, b] = starTint(sys.star.className);
  const starColor = new THREE.Color(r / 255, g / 255, b / 255);
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16), // unit sphere: scaled per mode below
    new THREE.MeshBasicMaterial({ color: starColor }), // unlit: reads as self-luminous, bloom-ready
  );
  star.name = 'star';
  star.scale.setScalar(STAR_RADIUS);
  root.add(star);
  root.add(new THREE.PointLight(starColor, 3, 0, 0));

  const hzInner = sys.star.hzInnerAu * AU_SCALE;
  const hzOuter = sys.star.hzOuterAu * AU_SCALE;
  const hz = new THREE.Mesh(
    new THREE.RingGeometry(hzInner, hzOuter, 96),
    new THREE.MeshBasicMaterial({ color: 0x2fbf71, transparent: true, opacity: 0.15, side: THREE.DoubleSide }),
  );
  hz.name = 'habitable-zone';
  hz.rotation.x = -Math.PI / 2;
  root.add(hz);

  const orbitRadius = sys.world.orbitAu * AU_SCALE;
  root.add(buildOrbitLine(orbitRadius));

  const worldGroup = new THREE.Object3D();
  worldGroup.name = 'world';
  // The same face at every altitude: the real cube-sphere mesh, smooth at
  // this radius (reliefScale 0), spun by worldSpinAngle so its subsolar
  // longitude agrees with the globe view — not a second blue marble.
  const worldSpin = new THREE.Object3D();
  worldSpin.name = 'world-spin';
  const worldMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 });
  // Deliberately always `natural`, never the selected lens: this view renders
  // at reliefScale 0 as an orbital diagram with no legend room, so a data
  // lens here would be uncaptioned and unreadable. orrery#5/#6 own giving
  // this view its own lens picker if that ever changes.
  const colorAt = (i: number) => naturalLens.colorAt(tiles, i, 0);
  for (let face = 0; face < 6; face++) {
    worldSpin.add(new THREE.Mesh(buildFaceGeometry(tiles, face, WORLD_RADIUS, 0, colorAt), worldMaterial));
  }
  // The mesh's polar axis is its local +z (cubeSphere's lat = asin(z));
  // stand it out of the orbit plane, leaning by the document's obliquity —
  // the same tilt the globe view encodes as its seasonal light swing, with
  // the lean aimed so northern midsummer lands at worldPhase 0.25, where
  // subsolarPoint's latitude peaks. The axis direction is fixed in the
  // inertial frame (no precession); only worldSpin's own z turns per frame.
  const worldAxis = new THREE.Object3D();
  worldAxis.rotation.x = -Math.PI / 2 - (sys.world.obliquityDeg * Math.PI) / 180;
  worldAxis.add(worldSpin);
  worldGroup.add(worldAxis);
  root.add(worldGroup);

  const moonMeshes: THREE.Mesh[] = sys.moons.map((_m, i) => {
    const surface = moons.moons[i]!;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8), // unit sphere: scaled per mode below
      new THREE.MeshStandardMaterial({
        color: moonBaseColor(surface),
        map: moonTexture(sys.seed, i, surface),
        roughness: 1,
      }),
    );
    mesh.name = `moon-${i}`;
    mesh.scale.setScalar(moonRadiusUnitsFromKm(surface.radiusKm, false));
    worldGroup.add(mesh);
    return mesh;
  });

  const reach = Math.max(orbitRadius, hzOuter);
  root.add(buildRealStarfield(neighbors, sys.world.obliquityDeg, reach));

  let trueScale = false;

  function worldPosition(day: number): THREE.Vector3 {
    const angle = orbitAngle(sys, day);
    return new THREE.Vector3(orbitRadius * Math.cos(angle), 0, orbitRadius * Math.sin(angle));
  }

  function update(day: number): void {
    worldGroup.position.copy(worldPosition(day));
    worldSpin.rotation.z = worldSpinAngle(sys, day);
    for (let i = 0; i < moonMeshes.length; i++) {
      moonMeshes[i]!.position.copy(moonLocalPosition(sys, i, day, trueScale));
    }
    // moonPhase (illumination, ./ephemeris.ts) is deliberately not consulted
    // here: the real point light at the star produces correct-looking
    // lit/dark faces on the moon spheres from their actual 3D position —
    // see moonOrbitalPhase's doc comment above.
  }

  function setTrueScale(on: boolean): void {
    trueScale = on;
    star.scale.setScalar(starRadiusUnits(on));
    worldSpin.scale.setScalar(worldRadiusUnits(on) / WORLD_RADIUS);
    for (let i = 0; i < moonMeshes.length; i++) {
      moonMeshes[i]!.scale.setScalar(moonRadiusUnitsFromKm(moons.moons[i]!.radiusKm, on));
    }
  }

  update(0);

  return { object3d: root, update, worldPosition, setTrueScale };
}
