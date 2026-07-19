/** The cloud advection overlay (The Rains).
 *
 * Sibling to `./currents.ts`: same split (pure tangent-frame geometry,
 * unit-tested without WebGL; a three.js builder that consumes it) and the
 * same `null`-on-no-data contract. Unlike currents (which advect along a
 * per-tile vector field the producer already computed), clouds advect along
 * the *wind*, which the client reconstructs from `circulationBands` via
 * `../sim/climate`'s `windAt` — the same closed-form evaluator `./winds.ts`
 * draws its static arrows from, reused here unchanged rather than
 * re-derived. That reconstruction only exists on a spinning world (a locked
 * world reports no bands), so this overlay is `null` there — there is
 * nothing to advect along.
 *
 * The particles genuinely drift (the Living Globe pattern, decision 0022):
 * each is a short puff riding a persistent `CloudParticle` (position + age),
 * stepped every frame by the pure `stepParticle` along the wind's tangent,
 * fading with age, and re-seeding at a fresh random high-cloud-fraction
 * position when it ages out or drifts off a cloudy cell. Non-deterministic
 * client eyecandy: seeding and re-seeding are `Math.random`-sampled, never
 * derived from the world seed — only the per-step geometry (`windTangentAt`,
 * `stepParticle`) is pure and tested. The visual treatment here (short
 * streaks, matching `currents.ts`) is a placeholder; a softer billowing
 * "veil" look is a presentation-only follow-up. */
import * as THREE from 'three';
import { windAt } from '../sim/climate';
import type { TilesScene } from '../sim/scene';
import { sampleTile } from './worldMesh';
import { unitLatLon } from './cubeSphere';

/** How many cloud puffs to draw, at most (one world-space line segment
 * each) — a fixed budget independent of the tile lattice's resolution,
 * mirroring `currents.ts`'s `CURRENT_PARTICLES`. */
export const CLOUD_PARTICLES = 700;

/** A tile counts as cloudy (a valid seed/re-seed target) once its
 * `cloudFraction` clears this — well above the `CLOUD_BASE` (0.3) floor the
 * producer's model always contributes, so only genuinely cloudy cells (rising
 * bands or orographic uplift) seed a puff. */
export const CLOUD_FRACTION_THRESHOLD = 0.5;

/** Puff length, as a fraction of the sphere's radius — shorter than a
 * current arrow (clouds drift slower, and read as puffs, not streaks). */
const PUFF_LENGTH = 0.03;

/** Lift above the sphere, higher than the currents/winds overlays
 * (`LIFT` in `currents.ts`/`winds.ts`) so clouds visibly float above both. */
const LIFT = 1.03;

/** Squared-length floor below which a tangent-frame vector counts as zero
 * (the poles, where east is undefined) — mirrors `currents.ts`'s
 * `POLE_EPSILON_SQ`. */
const POLE_EPSILON_SQ = 1e-18;

/** The puffs' base color (0-1 channels) — a pale, slightly cool white,
 * distinct from the currents overlay's `BASE_COLOR`; a particle's drawn
 * color is this scaled by its opacity, fading toward the black of space as
 * it ages (mirrors `currents.ts`'s fade-by-darkening convention). */
const BASE_COLOR: readonly [number, number, number] = [0xf0 / 255, 0xf6 / 255, 0xff / 255];

/** Sim days a particle lives before it re-seeds regardless of where it
 * drifted — mirrors `currents.ts`'s `PARTICLE_MAX_AGE_DAYS`. Tuning knob,
 * not a contract (presentation only, decision 0022). */
export const CLOUD_PARTICLE_MAX_AGE_DAYS = 5;

/** Radians of tangent-plane drift per sim day for a cloud puff — clouds
 * drift more slowly than the ocean-current arrows (`currents.ts`'s
 * `PARTICLE_SPEED`); tuning knob, not a contract. */
export const CLOUD_PARTICLE_SPEED = 3;

/** Clamp on one `update` call's `dt` (sim days) — mirrors `currents.ts`'s
 * `MAX_STEP_DAYS` (a day *scrub* must not visibly teleport the field). */
const MAX_STEP_DAYS = CLOUD_PARTICLE_MAX_AGE_DAYS;

/** Lat/lon (degrees) to a point on a unit sphere — same convention as
 * `currents.ts`'s `unitPosition`. */
function unitPosition(lat: number, lon: number): THREE.Vector3 {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(latRad) * Math.cos(lonRad),
    Math.cos(latRad) * Math.sin(lonRad),
    Math.sin(latRad),
  );
}

/** The local eastward unit tangent at a unit-sphere `position` — zero at the
 * poles, mirroring `currents.ts`'s `eastTangent`/the producer's
 * `wind_east_tangent` (`east = normalize(cross([0, 0, 1], position))`). */
function eastTangent(position: THREE.Vector3): THREE.Vector3 {
  const east = new THREE.Vector3(0, 0, 1).cross(position);
  return east.lengthSq() < POLE_EPSILON_SQ ? east.set(0, 0, 0) : east.normalize();
}

/** Maps a latitude/longitude to the world-space wind tangent there, purely
 * zonal (the prevailing-wind model has no meridional component — see
 * `../sim/climate`'s `windAt` doc comment): `windAt`'s direction (never
 * re-derived here, the producer's own evaluator, matching `./winds.ts`'s
 * convention) sets the sign along the eastward tangent. Zero at the poles,
 * where east is undefined. */
export function windTangentAt(bands: number, latDeg: number, lonDeg: number): THREE.Vector3 {
  const position = unitPosition(latDeg, lonDeg);
  const east = eastTangent(position);
  if (east.lengthSq() === 0) return east;
  const { direction } = windAt(bands, latDeg);
  const sign = direction === 'easterly' ? 1 : -1;
  return east.multiplyScalar(sign);
}

/** The lat/lon (degrees) at the center of row-major tile `index` — same
 * addressing as `currents.ts`'s `tileLatLon` (the exact inverse of
 * `./worldMesh.ts`'s `tileIndex`). */
function tileLatLon(tiles: TilesScene, index: number): { lat: number; lon: number } {
  const row = Math.floor(index / tiles.width);
  const col = index % tiles.width;
  const lat = 90 - ((row + 0.5) / tiles.height) * 180;
  const lon = ((col + 0.5) / tiles.width) * 360 - 180;
  return { lat, lon };
}

/** One drifting cloud particle: a position on the unit sphere (radius 1)
 * plus its age (sim days since it was last seeded) and the opacity that age
 * implies — mirrors `currents.ts`'s `CurrentParticle`. Non-deterministic
 * client eyecandy (decision 0022), not tied to the world seed. */
export interface CloudParticle {
  /** Unit-sphere position (radius 1); the caller scales by the rendered
   * radius when drawing. */
  position: THREE.Vector3;
  /** Sim days since this particle was last (re-)seeded. */
  age: number;
  /** Derived from `age` via `particleOpacity`; cached here so the renderer
   * never recomputes it mid-frame. */
  opacity: number;
}

/** A particle's opacity at `age` days since its last seed — identical shape
 * to `currents.ts`'s `particleOpacity`: full brightness for the first
 * two-thirds of its life, then a linear fade to 0 over the last third, so it
 * never pops instantly out of existence. Pure, unit-tested without WebGL. */
export function particleOpacity(age: number): number {
  const t = Math.min(1, Math.max(0, age / CLOUD_PARTICLE_MAX_AGE_DAYS));
  return t <= 2 / 3 ? 1 : Math.max(0, 3 * (1 - t));
}

/** One particle's per-frame advection step — identical shape to
 * `currents.ts`'s `stepParticle`: a tangent-plane Euler step followed by
 * re-normalization onto the unit sphere (`tangent` is always perpendicular
 * to `position`, so this tracks the sphere's geodesic to first order in
 * `dt`). `reseed` is true when the caller must replace this particle instead
 * of using the returned position: it aged out, or `tangent` is zero (only at
 * the poles — the wind field itself is never zero elsewhere, unlike currents'
 * land tiles). The caller (`createClouds`'s `update`) additionally forces a
 * reseed when the particle has drifted off a cloudy cell — that check needs
 * the tile lattice, so it lives there, not here; this function only signals
 * the pole/age-out case. `dt` is the sim-day delta since the last frame. */
export function stepParticle(
  position: THREE.Vector3,
  age: number,
  tangent: THREE.Vector3,
  dt: number,
): { position: THREE.Vector3; age: number; opacity: number; reseed: boolean } {
  const nextAge = age + dt;
  const reseed = tangent.lengthSq() === 0 || nextAge >= CLOUD_PARTICLE_MAX_AGE_DAYS;
  const next = reseed
    ? position
    : position.clone().addScaledVector(tangent, dt * CLOUD_PARTICLE_SPEED).normalize();
  return { position: next, age: nextAge, opacity: particleOpacity(nextAge), reseed };
}

/** The overlay, or `null` when there is no wind to advect along (a tidally
 * locked world reports no `circulationBands`) or no cell clears the cloud
 * threshold at all — the caller must SAY so rather than silently hiding the
 * control. */
export function createClouds(
  tiles: TilesScene,
  radius: number,
): { object3d: THREE.Object3D; setVisible(on: boolean): void; update(day: number): void } | null {
  if (tiles.circulationBands === null) return null;
  const bands: number = tiles.circulationBands;

  const candidates: number[] = [];
  for (let i = 0; i < tiles.cloudFraction.length; i++) {
    if (tiles.cloudFraction[i]! >= CLOUD_FRACTION_THRESHOLD) candidates.push(i);
  }
  if (candidates.length === 0) return null;

  const r = radius * LIFT;

  /** The world-space wind tangent at a unit-sphere `position`. */
  function tangentAt(position: THREE.Vector3): THREE.Vector3 {
    const { latDeg, lonDeg } = unitLatLon([position.x, position.y, position.z]);
    return windTangentAt(bands, latDeg, lonDeg);
  }

  /** Whether the tile under unit-sphere `position` still clears the cloud
   * threshold — the check a drifted particle needs before it can keep
   * living there (see `stepParticle`'s doc comment for why this lives here,
   * not in the pure stepper). */
  function isCloudyAt(position: THREE.Vector3): boolean {
    const { latDeg, lonDeg } = unitLatLon([position.x, position.y, position.z]);
    return sampleTile(tiles, latDeg, lonDeg, 'cloudFraction') >= CLOUD_FRACTION_THRESHOLD;
  }

  /** A freshly-seeded particle at a random cloudy tile. `randomizeAge`
   * spreads the INITIAL population's ages (mirrors `currents.ts`'s
   * `seedParticle`); a mid-simulation re-seed is a birth: age 0, full
   * opacity — a reborn particle fades IN, never appears already faded. */
  function seedParticle(randomizeAge: boolean): CloudParticle {
    const i = candidates[Math.floor(Math.random() * candidates.length)]!;
    const { lat, lon } = tileLatLon(tiles, i);
    const age = randomizeAge ? Math.random() * CLOUD_PARTICLE_MAX_AGE_DAYS : 0;
    return { position: unitPosition(lat, lon), age, opacity: particleOpacity(age) };
  }

  const seeds = Math.min(CLOUD_PARTICLES, candidates.length);
  const particles: CloudParticle[] = Array.from({ length: seeds }, () => seedParticle(true));

  const positions = new Float32Array(seeds * 2 * 3);
  const colors = new Float32Array(seeds * 2 * 3);

  /** Writes particle `k`'s puff (base at its lifted position, tip along the
   * wind's direction there) into the shared position/color buffers —
   * mirrors `currents.ts`'s `writeParticle`. */
  function writeParticle(k: number, p: CloudParticle, tangent: THREE.Vector3): void {
    const base = p.position.clone().multiplyScalar(r);
    let tipX = base.x;
    let tipY = base.y;
    let tipZ = base.z;
    if (tangent.lengthSq() > 0) {
      const dir = tangent.clone().normalize();
      tipX += dir.x * PUFF_LENGTH * radius;
      tipY += dir.y * PUFF_LENGTH * radius;
      tipZ += dir.z * PUFF_LENGTH * radius;
    }
    const o = 6 * k;
    positions[o] = base.x;
    positions[o + 1] = base.y;
    positions[o + 2] = base.z;
    positions[o + 3] = tipX;
    positions[o + 4] = tipY;
    positions[o + 5] = tipZ;
    const cr = BASE_COLOR[0] * p.opacity;
    const cg = BASE_COLOR[1] * p.opacity;
    const cb = BASE_COLOR[2] * p.opacity;
    colors[o] = cr;
    colors[o + 1] = cg;
    colors[o + 2] = cb;
    colors[o + 3] = cr;
    colors[o + 4] = cg;
    colors[o + 5] = cb;
  }

  for (let k = 0; k < seeds; k++) {
    const p = particles[k]!;
    writeParticle(k, p, tangentAt(p.position));
  }

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('color', colorAttr);
  const lines = new THREE.LineSegments(
    geom,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }),
  );
  lines.name = 'globe-clouds';
  lines.visible = false;

  // The last day `update` saw — mirrors `currents.ts`'s `lastDay` baseline.
  let lastDay: number | null = null;

  function update(day: number): void {
    if (lastDay === null) {
      lastDay = day;
      return;
    }
    const dt = Math.max(0, Math.min(day - lastDay, MAX_STEP_DAYS));
    lastDay = day;
    for (let k = 0; k < particles.length; k++) {
      const p = particles[k]!;
      const tangent = tangentAt(p.position);
      const stepped = stepParticle(p.position, p.age, tangent, dt);
      const reseed = stepped.reseed || !isCloudyAt(stepped.position);
      const next: CloudParticle = reseed
        ? seedParticle(false)
        : { position: stepped.position, age: stepped.age, opacity: stepped.opacity };
      particles[k] = next;
      writeParticle(k, next, tangentAt(next.position));
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  return {
    object3d: lines,
    setVisible: (on) => {
      lines.visible = on;
    },
    update,
  };
}
