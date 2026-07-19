import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CURRENT_PARTICLES,
  PARTICLE_MAX_AGE_DAYS,
  createCurrents,
  currentTangentAt,
  particleOpacity,
  stepParticle,
} from './currents';
import type { TilesScene } from '../sim/scene';

function tilesFixture(opts: {
  width: number;
  height: number;
  ocean: boolean[];
  currentEast: number[];
  currentNorth: number[];
}): TilesScene {
  return opts as never;
}

describe('currentTangentAt', () => {
  it('returns zero for a zero current (land, or a locked world)', () => {
    const v = currentTangentAt(0, 0, 12, 34);
    expect(v.lengthSq()).toBe(0);
  });

  it('returns a nonzero tangent vector for a nonzero ocean current', () => {
    const v = currentTangentAt(1, 0, 0, 0);
    expect(v.lengthSq()).toBeGreaterThan(0);
  });

  it('projects a pure-eastward current onto the eastward tangent at the equator/prime-meridian', () => {
    // At lat=0, lon=0 the unit position is (1, 0, 0); east = normalize(cross([0,0,1], position))
    // works out to (0, 1, 0) there, so a pure-east current should land entirely on +y.
    const v = currentTangentAt(1, 0, 0, 0);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(v.z).toBeCloseTo(0);
  });

  it('projects a pure-northward current onto the northward tangent at the equator/prime-meridian', () => {
    // North there is (0, 0, 1) — toward the pole along the z axis.
    const v = currentTangentAt(0, 1, 0, 0);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(1);
  });

  it('the tangent lies in the tangent plane (perpendicular to the surface normal)', () => {
    const position = new THREE.Vector3(
      Math.cos((15 * Math.PI) / 180) * Math.cos((40 * Math.PI) / 180),
      Math.cos((15 * Math.PI) / 180) * Math.sin((40 * Math.PI) / 180),
      Math.sin((15 * Math.PI) / 180),
    );
    const v = currentTangentAt(0.4, -0.7, 15, 40);
    expect(v.dot(position)).toBeCloseTo(0);
  });

  it('is zero at the poles, where east/north are undefined', () => {
    const v = currentTangentAt(1, 1, 90, 0);
    expect(v.lengthSq()).toBe(0);
  });
});

describe('createCurrents', () => {
  it('returns null when every tile carries a zero current (a locked world)', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      ocean: [true, true, true, true, true, true, true, true],
      currentEast: Array(8).fill(0),
      currentNorth: Array(8).fill(0),
    });
    expect(createCurrents(tiles, 1)).toBeNull();
  });

  it('returns null when there are no ocean tiles at all', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      ocean: Array(8).fill(false),
      currentEast: Array(8).fill(1),
      currentNorth: Array(8).fill(1),
    });
    expect(createCurrents(tiles, 1)).toBeNull();
  });

  it('builds a line-segment overlay when at least one ocean tile carries a current', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      ocean: [true, false, false, false, false, false, false, false],
      currentEast: [0.5, 0, 0, 0, 0, 0, 0, 0],
      currentNorth: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const currents = createCurrents(tiles, 1)!;
    expect(currents).not.toBeNull();
    const lines = currents.object3d as THREE.LineSegments;
    expect(lines.geometry.getAttribute('position').count).toBe(2); // one arrow, two vertices
  });

  it('starts hidden', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      ocean: [true, false],
      currentEast: [0.5, 0],
      currentNorth: [0, 0],
    });
    expect(createCurrents(tiles, 1)!.object3d.visible).toBe(false);
  });

  it('shows and hides', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      ocean: [true, false],
      currentEast: [0.5, 0],
      currentNorth: [0, 0],
    });
    const currents = createCurrents(tiles, 1)!;
    currents.setVisible(true);
    expect(currents.object3d.visible).toBe(true);
    currents.setVisible(false);
    expect(currents.object3d.visible).toBe(false);
  });

  it('sits above the sphere so relief cannot swallow it', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      ocean: [true, false],
      currentEast: [0.5, 0],
      currentNorth: [0, 0],
    });
    const currents = createCurrents(tiles, 10)!;
    const p = (currents.object3d as THREE.LineSegments).geometry.getAttribute('position');
    // Only the arrow's base is pinned to the lifted sphere radius; the tip is
    // offset along the tangent, so check the base vertex (index 0) only.
    const base = new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0));
    expect(base.length()).toBeGreaterThan(10);
  });

  it('never draws more arrows than CURRENT_PARTICLES, however many ocean tiles carry current', () => {
    const n = 1000;
    const tiles = tilesFixture({
      width: n,
      height: 1,
      ocean: Array(n).fill(true),
      currentEast: Array(n).fill(0.3),
      currentNorth: Array(n).fill(0.4),
    });
    const currents = createCurrents(tiles, 1)!;
    const count = (currents.object3d as THREE.LineSegments).geometry.getAttribute('position').count;
    expect(count).toBeLessThanOrEqual(CURRENT_PARTICLES * 2);
    expect(count).toBeGreaterThan(0);
  });

  it('advects when visible and the toggle drives it (update is exposed)', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      ocean: [true, false, false, false, false, false, false, false],
      currentEast: [0.5, 0, 0, 0, 0, 0, 0, 0],
      currentNorth: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const currents = createCurrents(tiles, 1)!;
    expect(typeof currents.update).toBe('function');
    // First call only establishes the day baseline (no motion yet); the
    // second call actually steps — neither should throw, and the arrow's
    // base must stay on the lifted sphere (a particle only ever moves in
    // the tangent plane and re-normalizes).
    currents.update(0);
    currents.update(0.01);
    const p = currents.object3d as THREE.LineSegments;
    const pos = p.geometry.getAttribute('position');
    const base = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
    expect(base.length()).toBeCloseTo(1.015, 5); // radius(1) * LIFT
  });
});

describe('particleOpacity', () => {
  it('is fully opaque for the first two-thirds of a particle life', () => {
    expect(particleOpacity(0)).toBe(1);
    expect(particleOpacity(PARTICLE_MAX_AGE_DAYS * 0.5)).toBe(1);
  });

  it('fades linearly to zero over the last third of life', () => {
    const nearEnd = particleOpacity(PARTICLE_MAX_AGE_DAYS * 0.9);
    const atEnd = particleOpacity(PARTICLE_MAX_AGE_DAYS);
    expect(nearEnd).toBeGreaterThan(atEnd);
    expect(atEnd).toBe(0);
  });

  it('never goes negative past its lifetime', () => {
    expect(particleOpacity(PARTICLE_MAX_AGE_DAYS * 2)).toBe(0);
  });
});

describe('stepParticle', () => {
  it('moves a particle over a nonzero current in the current\'s direction', () => {
    // At lat=0, lon=0 the unit position is (1, 0, 0); a pure-eastward
    // current's tangent there is (0, 1, 0) (see currentTangentAt's tests).
    const position = new THREE.Vector3(1, 0, 0);
    const tangent = currentTangentAt(1, 0, 0, 0);
    const result = stepParticle(position, 0, tangent, 0.05);
    expect(result.reseed).toBe(false);
    const delta = result.position.clone().sub(position);
    expect(delta.dot(tangent)).toBeGreaterThan(0);
    // Stays on the unit sphere (tangent-plane step + renormalize).
    expect(result.position.length()).toBeCloseTo(1, 10);
  });

  it('ages the particle by dt and fades its opacity accordingly', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const tangent = currentTangentAt(1, 0, 0, 0);
    const result = stepParticle(position, 1, tangent, 0.5);
    expect(result.age).toBeCloseTo(1.5, 10);
    expect(result.opacity).toBe(particleOpacity(1.5));
  });

  it('re-seeds when the particle ages out', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const tangent = currentTangentAt(1, 0, 0, 0);
    const result = stepParticle(position, PARTICLE_MAX_AGE_DAYS - 0.001, tangent, 1);
    expect(result.reseed).toBe(true);
  });

  it('re-seeds when it lands on a zero-current cell (land, or a currentless tile)', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const zeroTangent = new THREE.Vector3(0, 0, 0);
    const result = stepParticle(position, 0, zeroTangent, 0.1);
    expect(result.reseed).toBe(true);
  });

  it('does not move a re-seeding particle itself — the caller replaces it', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const zeroTangent = new THREE.Vector3(0, 0, 0);
    const result = stepParticle(position, 0, zeroTangent, 0.1);
    expect(result.position).toBe(position); // same reference: no wasted work
  });
});
