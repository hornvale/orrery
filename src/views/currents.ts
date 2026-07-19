/** The ocean-current advection overlay.
 *
 * Sibling to `./winds.ts`: same split (pure tangent-frame geometry,
 * unit-tested without WebGL; a three.js builder that consumes it) and the
 * same `null`-on-no-data contract. Unlike winds (static arrows drawn from a
 * closed-form band model), the current field is per-tile data the producer
 * already computed (`windows/scene`'s `tiles_scene`: zero over land, zero
 * everywhere on a locked world) — this overlay reads it, never re-derives
 * it.
 *
 * The particles genuinely drift (the Living Globe pattern): each is a short
 * arrow riding a persistent `CurrentParticle` (position + age), stepped
 * every frame by the pure `stepParticle` along `currentTangentAt`'s vector,
 * fading with age, and re-seeding at a fresh random ocean position when it
 * ages out or drifts onto land / a currentless cell. Non-deterministic
 * client eyecandy (decision 0022): seeding and re-seeding are
 * `Math.random`-sampled, never derived from the world seed — only the
 * per-step geometry (`currentTangentAt`, `stepParticle`) is pure and tested. */
import * as THREE from 'three';
import type { TilesScene } from '../sim/scene';
import { sampleTile } from './worldMesh';
import { unitLatLon } from './cubeSphere';

/** How many current arrows to draw, at most (one world-space line segment
 * each) — a fixed budget independent of the tile lattice's resolution
 * (hundreds of thousands of ocean tiles at the client's 512-wide fetch), so
 * the overlay stays cheap regardless of how fine the lattice gets. */
export const CURRENT_PARTICLES = 400;

/** Arrow length, as a fraction of the sphere's radius. */
const ARROW_LENGTH = 0.02;

/** Lift above the sphere, so exaggerated relief cannot swallow the arrows —
 * matches `winds.ts`'s LIFT. */
const LIFT = 1.015;

/** Squared-length floor below which a tangent-frame vector counts as zero
 * (the poles, where east/north are undefined) — mirrors the producer's own
 * `1e-9` guards in `windows/scene`'s `wind_east_tangent`/`tangent_north`. */
const POLE_EPSILON_SQ = 1e-18;

/** The arrows' base color (0-1 channels), matching the old static overlay's
 * `0x8fd9ff` — a particle's drawn color is this scaled by its opacity, so it
 * visibly fades toward the black of space as it ages. */
const BASE_COLOR: readonly [number, number, number] = [0x8f / 255, 0xd9 / 255, 0xff / 255];

/** Sim days a particle lives before it re-seeds regardless of where it
 * drifted — keeps the field looking alive (continuous births and deaths)
 * rather than a fixed set of dots orbiting forever. Tuning knob, not a
 * contract (presentation only, decision 0022). */
export const PARTICLE_MAX_AGE_DAYS = 6;

/** Radians of tangent-plane drift per sim day per unit of (currentEast,
 * currentNorth) magnitude. Tuning knob: picked so the fixture-scale (~0.1
 * unit) currents creep a visible arc over a few sim days at the globe's
 * default clock speed, while a current several times stronger visibly
 * outruns it — the relative comparison (`speed ∝ |current|`) is the
 * contract; the constant itself is not. */
export const PARTICLE_SPEED = 6;

/** Clamp on one `update` call's `dt` (sim days) — a day *scrub* (the HUD
 * slider, or a URL hash edit) can jump `day` by anything, forward or
 * backward; capping the step to one particle lifetime avoids a visible
 * teleport while still letting a huge forward jump drift the field a
 * plausible amount rather than freezing it. */
const MAX_STEP_DAYS = PARTICLE_MAX_AGE_DAYS;

/** Lat/lon (degrees) to a point on a unit sphere — the same convention as
 * `winds.ts`'s `onSphere` (and the producer's tangent-frame construction: lat
 * = asin(z), lon = atan2(y, x)), just at radius 1 so it doubles as the
 * tangent-frame's local "position" vector. */
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
 * poles (undefined there), mirroring the producer's `wind_east_tangent`
 * (`east = normalize(cross([0, 0, 1], position))`). */
function eastTangent(position: THREE.Vector3): THREE.Vector3 {
  const east = new THREE.Vector3(0, 0, 1).cross(position);
  return east.lengthSq() < POLE_EPSILON_SQ ? east.set(0, 0, 0) : east.normalize();
}

/** The local northward unit tangent completing the (east, north) frame —
 * zero wherever `east` is zero, mirroring the producer's `tangent_north`
 * (`north = normalize(cross(position, east))`). */
function northTangent(position: THREE.Vector3, east: THREE.Vector3): THREE.Vector3 {
  const north = position.clone().cross(east);
  return north.lengthSq() < POLE_EPSILON_SQ ? north.set(0, 0, 0) : north.normalize();
}

/** Maps a tile's `(currentEast, currentNorth)` local-tangent components plus
 * its lat/lon into a world-space (unit-sphere-frame) advection vector — the
 * pure geometry this overlay owns, unit-tested without WebGL. Zero in, zero
 * out: a land tile or a locked world (both zeroed by the producer) advects
 * nothing, so the caller can tell "no current" from "current" by
 * `lengthSq() === 0` alone. Reused unchanged (verified byte-exact against
 * the producer) by the particle stepper below — its frame never changes. */
export function currentTangentAt(
  currentEast: number,
  currentNorth: number,
  lat: number,
  lon: number,
): THREE.Vector3 {
  if (currentEast === 0 && currentNorth === 0) return new THREE.Vector3(0, 0, 0);
  const position = unitPosition(lat, lon);
  const east = eastTangent(position);
  const north = northTangent(position, east);
  return east.multiplyScalar(currentEast).addScaledVector(north, currentNorth);
}

/** The lat/lon (degrees) at the center of row-major tile `index` — the exact
 * inverse of `./worldMesh.ts`'s `tileIndex`, and identical to the producer's
 * own per-tile latitude/longitude in `windows/scene`'s `tiles_scene`. */
function tileLatLon(tiles: TilesScene, index: number): { lat: number; lon: number } {
  const row = Math.floor(index / tiles.width);
  const col = index % tiles.width;
  const lat = 90 - ((row + 0.5) / tiles.height) * 180;
  const lon = ((col + 0.5) / tiles.width) * 360 - 180;
  return { lat, lon };
}

/** One drifting current particle: a position on the unit sphere (radius 1,
 * matching `unitPosition`/`currentTangentAt`'s frame) plus its age (sim days
 * since it was last seeded) and the opacity that age implies. Mutable state
 * that `createCurrents`'s `update` steps each frame — not itself tied to the
 * world seed (see the module doc comment). */
export interface CurrentParticle {
  /** Unit-sphere position (radius 1); the caller scales by the rendered
   * radius when drawing. */
  position: THREE.Vector3;
  /** Sim days since this particle was last (re-)seeded. */
  age: number;
  /** Derived from `age` via `particleOpacity`; cached here so the renderer
   * never recomputes it mid-frame. */
  opacity: number;
}

/** A particle's opacity at `age` days since its last seed: full brightness
 * for the first two-thirds of its life, then a linear fade to 0 over the
 * last third — so it never pops instantly out of existence. Pure,
 * unit-tested without WebGL. */
export function particleOpacity(age: number): number {
  const t = Math.min(1, Math.max(0, age / PARTICLE_MAX_AGE_DAYS));
  return t <= 2 / 3 ? 1 : Math.max(0, 3 * (1 - t));
}

/** One particle's per-frame advection step. `tangent` is the world-space
 * current vector at `position` (from `currentTangentAt`, unchanged and
 * reused as-is — never re-derived here). Movement is a tangent-plane Euler
 * step followed by re-normalization onto the unit sphere: `tangent` is
 * always perpendicular to `position` (it's built from the east/north basis
 * at that point), so adding a small multiple of it and renormalizing tracks
 * the sphere's geodesic to first order in `dt`, with no lat/lon
 * longitude-scaling singularity near the poles.
 *
 * `reseed` is true when the caller must replace this particle instead of
 * using the returned position: it aged out, or `tangent` is zero (the tile
 * it occupies is land or a currentless cell — which only happens after a
 * previous step drifted it there, or the whole field is empty). This
 * function only signals *that*; picking a fresh random ocean position is
 * the caller's job (it owns the tile lattice and the RNG). `dt` is the
 * sim-day delta since the last frame (zero while paused) — the caller
 * clamps it against a scrubbed `day` before calling. */
export function stepParticle(
  position: THREE.Vector3,
  age: number,
  tangent: THREE.Vector3,
  dt: number,
): { position: THREE.Vector3; age: number; opacity: number; reseed: boolean } {
  const nextAge = age + dt;
  const reseed = tangent.lengthSq() === 0 || nextAge >= PARTICLE_MAX_AGE_DAYS;
  const next = reseed ? position : position.clone().addScaledVector(tangent, dt * PARTICLE_SPEED).normalize();
  return { position: next, age: nextAge, opacity: particleOpacity(nextAge), reseed };
}

/** The overlay, or `null` when the world has no ocean-current data to show —
 * a locked world (or an all-land seed) zeroes the whole field, and the
 * caller must SAY so rather than silently hiding the control. */
export function createCurrents(
  tiles: TilesScene,
  radius: number,
): { object3d: THREE.Object3D; setVisible(on: boolean): void; update(day: number): void } | null {
  const candidates: number[] = [];
  for (let i = 0; i < tiles.ocean.length; i++) {
    if (tiles.ocean[i] && (tiles.currentEast[i] !== 0 || tiles.currentNorth[i] !== 0)) {
      candidates.push(i);
    }
  }
  if (candidates.length === 0) return null;

  const r = radius * LIFT;

  /** The world-space current tangent at a unit-sphere `position`, sampling
   * whichever tile it currently sits over (nearest-tile lookup, the same
   * addressing `sampleTile` uses for every other per-tile field). */
  function tangentAt(position: THREE.Vector3): THREE.Vector3 {
    const { latDeg, lonDeg } = unitLatLon([position.x, position.y, position.z]);
    const east = sampleTile(tiles, latDeg, lonDeg, 'currentEast');
    const north = sampleTile(tiles, latDeg, lonDeg, 'currentNorth');
    return currentTangentAt(east, north, latDeg, lonDeg);
  }

  /** A freshly-seeded particle at a random current-bearing ocean tile.
   * Retried a bounded few times against the vanishing chance a candidate
   * sits close enough to a pole that its east/north tangent frame comes out
   * zero despite a nonzero `(currentEast, currentNorth)` — if every retry
   * lands there anyway (never observed in practice), the particle simply
   * re-seeds again on the very next frame rather than the overlay failing. */
  function seedParticle(): CurrentParticle {
    for (let attempt = 0; attempt < 8; attempt++) {
      const i = candidates[Math.floor(Math.random() * candidates.length)]!;
      const { lat, lon } = tileLatLon(tiles, i);
      const position = unitPosition(lat, lon);
      if (currentTangentAt(tiles.currentEast[i]!, tiles.currentNorth[i]!, lat, lon).lengthSq() > 0) {
        // Ages are randomized at birth so particles don't all re-seed in
        // lockstep — a field that pulses together reads as artificial.
        const age = Math.random() * PARTICLE_MAX_AGE_DAYS;
        return { position, age, opacity: particleOpacity(age) };
      }
    }
    const i = candidates[0]!;
    const { lat, lon } = tileLatLon(tiles, i);
    return { position: unitPosition(lat, lon), age: 0, opacity: 1 };
  }

  const seeds = Math.min(CURRENT_PARTICLES, candidates.length);
  const particles: CurrentParticle[] = Array.from({ length: seeds }, seedParticle);

  const positions = new Float32Array(seeds * 2 * 3);
  const colors = new Float32Array(seeds * 2 * 3);

  /** Writes particle `k`'s arrow (base at its lifted position, tip along the
   * current's direction at that position) into the shared position/color
   * buffers — shared by the initial build and every `update` frame. */
  function writeParticle(k: number, p: CurrentParticle, tangent: THREE.Vector3): void {
    const base = p.position.clone().multiplyScalar(r);
    let tipX = base.x;
    let tipY = base.y;
    let tipZ = base.z;
    if (tangent.lengthSq() > 0) {
      const dir = tangent.clone().normalize();
      tipX += dir.x * ARROW_LENGTH * radius;
      tipY += dir.y * ARROW_LENGTH * radius;
      tipZ += dir.z * ARROW_LENGTH * radius;
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
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
  );
  lines.name = 'globe-currents';
  lines.visible = false;

  // The last day `update` saw — `null` until the first call, which only
  // establishes the baseline (no `dt` yet to step by), matching how a
  // freshly-mounted overlay must not jump on its very first frame.
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
      const next: CurrentParticle = stepped.reseed
        ? seedParticle()
        : { position: stepped.position, age: stepped.age, opacity: stepped.opacity };
      particles[k] = next;
      // Redraw at the particle's arrival tile, not its departure tile — a
      // moved (or freshly re-seeded) particle's arrow points along the
      // current where it now sits, not where it started this step.
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
