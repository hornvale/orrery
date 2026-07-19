import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CLOUD_FRACTION_THRESHOLD,
  CLOUD_PARTICLES,
  CLOUD_PARTICLE_MAX_AGE_DAYS,
  createClouds,
  particleOpacity,
  stepParticle,
  windTangentAt,
} from './clouds';
import type { TilesScene } from '../sim/scene';

function tilesFixture(opts: {
  width: number;
  height: number;
  circulationBands: number | null;
  cloudFraction: number[];
}): TilesScene {
  return opts as never;
}

describe('windTangentAt', () => {
  it('returns zero at the poles, where east is undefined', () => {
    const v = windTangentAt(3, 90, 0);
    expect(v.lengthSq()).toBe(0);
  });

  it('returns a nonzero tangent vector away from the poles', () => {
    const v = windTangentAt(3, 0, 0);
    expect(v.lengthSq()).toBeGreaterThan(0);
  });

  it('the tangent lies in the tangent plane (perpendicular to the surface normal)', () => {
    const position = new THREE.Vector3(
      Math.cos((15 * Math.PI) / 180) * Math.cos((40 * Math.PI) / 180),
      Math.cos((15 * Math.PI) / 180) * Math.sin((40 * Math.PI) / 180),
      Math.sin((15 * Math.PI) / 180),
    );
    const v = windTangentAt(3, 15, 40);
    expect(v.dot(position)).toBeCloseTo(0);
  });

  it('flips sign between an easterly (even) band and a westerly (odd) band', () => {
    // 3 bands, width 30°: band 0 is [0,30) equatorial (easterly), band 1 is
    // [30,60) (westerly) — see ../sim/climate's windAt.
    const equator = windTangentAt(3, 10, 0);
    const midLat = windTangentAt(3, 45, 0);
    expect(equator.dot(midLat)).toBeLessThan(0);
  });
});

describe('createClouds', () => {
  it('returns null on a locked world (no circulation bands to advect along)', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      circulationBands: null,
      cloudFraction: Array(8).fill(0.9),
    });
    expect(createClouds(tiles, 1)).toBeNull();
  });

  it('returns null when no tile clears the cloud threshold', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      circulationBands: 3,
      cloudFraction: Array(8).fill(0.1),
    });
    expect(createClouds(tiles, 1)).toBeNull();
  });

  it('builds a line-segment overlay when at least one tile clears the cloud threshold', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      circulationBands: 3,
      cloudFraction: [0.9, 0, 0, 0, 0, 0, 0, 0],
    });
    const clouds = createClouds(tiles, 1)!;
    expect(clouds).not.toBeNull();
    const lines = clouds.object3d as THREE.LineSegments;
    expect(lines.geometry.getAttribute('position').count).toBe(2); // one puff, two vertices
  });

  it('starts hidden', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      circulationBands: 3,
      cloudFraction: [0.9, 0.9],
    });
    expect(createClouds(tiles, 1)!.object3d.visible).toBe(false);
  });

  it('shows and hides', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      circulationBands: 3,
      cloudFraction: [0.9, 0.9],
    });
    const clouds = createClouds(tiles, 1)!;
    clouds.setVisible(true);
    expect(clouds.object3d.visible).toBe(true);
    clouds.setVisible(false);
    expect(clouds.object3d.visible).toBe(false);
  });

  it('sits above the sphere so relief cannot swallow it', () => {
    const tiles = tilesFixture({
      width: 2,
      height: 1,
      circulationBands: 3,
      cloudFraction: [0.9, 0.9],
    });
    const clouds = createClouds(tiles, 10)!;
    const p = (clouds.object3d as THREE.LineSegments).geometry.getAttribute('position');
    const base = new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0));
    expect(base.length()).toBeGreaterThan(10);
  });

  it('never draws more puffs than CLOUD_PARTICLES, however many tiles clear the threshold', () => {
    const n = 1000;
    const tiles = tilesFixture({
      width: n,
      height: 1,
      circulationBands: 3,
      cloudFraction: Array(n).fill(0.9),
    });
    const clouds = createClouds(tiles, 1)!;
    const count = (clouds.object3d as THREE.LineSegments).geometry.getAttribute('position').count;
    expect(count).toBeLessThanOrEqual(CLOUD_PARTICLES * 2);
    expect(count).toBeGreaterThan(0);
  });

  it('advects when the toggle drives it (update is exposed)', () => {
    const n = 200;
    const tiles = tilesFixture({
      width: n,
      height: 1,
      circulationBands: 3,
      cloudFraction: Array(n).fill(0.9), // all-cloudy belt: no drift-off re-seeds to fight the assertion
    });
    const clouds = createClouds(tiles, 1)!;
    expect(typeof clouds.update).toBe('function');
    // First call only establishes the day baseline (no motion yet); the
    // second call actually steps — neither should throw, and the puff's
    // base must stay on the lifted sphere (a particle only ever moves in
    // the tangent plane and re-normalizes).
    clouds.update(0);
    clouds.update(0.01);
    const p = clouds.object3d as THREE.LineSegments;
    const pos = p.geometry.getAttribute('position');
    const base = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
    expect(base.length()).toBeCloseTo(1.03, 5); // radius(1) * LIFT
  });
});

describe('particleOpacity', () => {
  it('is fully opaque for the first two-thirds of a particle life', () => {
    expect(particleOpacity(0)).toBe(1);
    expect(particleOpacity(CLOUD_PARTICLE_MAX_AGE_DAYS * 0.5)).toBe(1);
  });

  it('fades linearly to zero over the last third of life', () => {
    const nearEnd = particleOpacity(CLOUD_PARTICLE_MAX_AGE_DAYS * 0.9);
    const atEnd = particleOpacity(CLOUD_PARTICLE_MAX_AGE_DAYS);
    expect(nearEnd).toBeGreaterThan(atEnd);
    expect(atEnd).toBe(0);
  });

  it('never goes negative past its lifetime', () => {
    expect(particleOpacity(CLOUD_PARTICLE_MAX_AGE_DAYS * 2)).toBe(0);
  });
});

describe('stepParticle', () => {
  it('moves a particle along the wind tangent', () => {
    const position = new THREE.Vector3(1, 0, 0); // lat 0, lon 0
    const tangent = windTangentAt(3, 0, 0);
    const result = stepParticle(position, 0, tangent, 0.05);
    expect(result.reseed).toBe(false);
    const delta = result.position.clone().sub(position);
    expect(delta.dot(tangent)).toBeGreaterThan(0);
    // Stays on the unit sphere (tangent-plane step + renormalize).
    expect(result.position.length()).toBeCloseTo(1, 10);
  });

  it('ages the particle by dt and fades its opacity accordingly', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const tangent = windTangentAt(3, 0, 0);
    const result = stepParticle(position, 1, tangent, 0.5);
    expect(result.age).toBeCloseTo(1.5, 10);
    expect(result.opacity).toBe(particleOpacity(1.5));
  });

  it('a reborn particle (age 0) is at full opacity — a re-seed fades IN, never appears half-faded', () => {
    expect(particleOpacity(0)).toBe(1);
  });

  it('re-seeds when the particle ages out', () => {
    const position = new THREE.Vector3(1, 0, 0);
    const tangent = windTangentAt(3, 0, 0);
    const result = stepParticle(position, CLOUD_PARTICLE_MAX_AGE_DAYS - 0.001, tangent, 1);
    expect(result.reseed).toBe(true);
  });

  it('re-seeds when the tangent is zero (only ever true at the poles)', () => {
    const position = new THREE.Vector3(0, 0, 1);
    const zeroTangent = new THREE.Vector3(0, 0, 0);
    const result = stepParticle(position, 0, zeroTangent, 0.1);
    expect(result.reseed).toBe(true);
  });

  it('does not move a re-seeding particle itself — the caller replaces it', () => {
    const position = new THREE.Vector3(0, 0, 1);
    const zeroTangent = new THREE.Vector3(0, 0, 0);
    const result = stepParticle(position, 0, zeroTangent, 0.1);
    expect(result.position).toBe(position); // same reference: no wasted work
  });
});

// CLOUD_FRACTION_THRESHOLD is exercised through createClouds's tests above
// (a candidate must clear it); referenced here only to confirm it's exported
// for main.ts/globe.ts's availability-reason wiring to reuse if needed.
describe('CLOUD_FRACTION_THRESHOLD', () => {
  it('sits strictly between 0 and 1', () => {
    expect(CLOUD_FRACTION_THRESHOLD).toBeGreaterThan(0);
    expect(CLOUD_FRACTION_THRESHOLD).toBeLessThan(1);
  });
});
