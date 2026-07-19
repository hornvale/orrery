import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CLOUD_FRACTION_THRESHOLD,
  CLOUD_PARTICLES,
  CLOUD_PARTICLE_MAX_AGE_DAYS,
  cloudStyleFor,
  createClouds,
  luminance,
  particleOpacity,
  stepParticle,
  weightedIndex,
  windTangentAt,
} from './clouds';
import type { TilesScene } from '../sim/scene';

function tilesFixture(opts: {
  width: number;
  height: number;
  circulationBands: number | null;
  cloudFraction: number[];
  weatherPropensity?: number[];
  cloudType?: number[];
}): TilesScene {
  const n = opts.cloudFraction.length;
  return {
    // Defaults for tests that don't care about the typed-cloud fields: a
    // uniform mid-propensity, real (non-None) type so a candidate tile
    // always has *something* to sample a style from.
    weatherPropensity: opts.weatherPropensity ?? Array(n).fill(0.5),
    cloudType: opts.cloudType ?? Array(n).fill(1),
    ...opts,
  } as never;
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

  it('builds a point-sprite overlay when at least one tile clears the cloud threshold', () => {
    const tiles = tilesFixture({
      width: 4,
      height: 2,
      circulationBands: 3,
      cloudFraction: [0.9, 0, 0, 0, 0, 0, 0, 0],
    });
    const clouds = createClouds(tiles, 1)!;
    expect(clouds).not.toBeNull();
    const points = clouds.object3d as THREE.Points;
    expect(points.geometry.getAttribute('position').count).toBe(1); // one particle, one point
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
    const p = (clouds.object3d as THREE.Points).geometry.getAttribute('position');
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
    const count = (clouds.object3d as THREE.Points).geometry.getAttribute('position').count;
    expect(count).toBeLessThanOrEqual(CLOUD_PARTICLES);
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
    const p = clouds.object3d as THREE.Points;
    const pos = p.geometry.getAttribute('position');
    const base = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
    expect(base.length()).toBeCloseTo(1.03, 5); // radius(1) * LIFT
  });

  it('gives a bigger sprite size for Cumulonimbus (4) than for Cirrus (5) — cloudType drives sizeScale', () => {
    // Only tile 0 clears the cloud threshold, so every particle seeds
    // there and shares its cloudType's style.
    const cloudFraction = [0.9, 0, 0, 0, 0, 0, 0, 0];
    const pointSize = (type: number): number => {
      const tiles = tilesFixture({
        width: 4,
        height: 2,
        circulationBands: 3,
        cloudFraction,
        cloudType: [type, 0, 0, 0, 0, 0, 0, 0],
      });
      const clouds = createClouds(tiles, 1)!;
      const sizes = (clouds.object3d as THREE.Points).geometry.getAttribute('size');
      return sizes.getX(0);
    };
    expect(pointSize(4)).toBeGreaterThan(pointSize(5));
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

describe('cloudStyleFor', () => {
  it('is TOTAL over the wire range 0..=5 — every declared type resolves to a valid style', () => {
    for (let type = 0; type <= 5; type++) {
      const style = cloudStyleFor(type);
      expect(style.color).toHaveLength(3);
      for (const c of style.color) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      expect(style.sizeScale).toBeGreaterThan(0);
      expect(style.densityScale).toBeGreaterThan(0);
      expect(style.densityScale).toBeLessThanOrEqual(1);
    }
  });

  it('gives every one of the six types a distinct color — a real per-type distinction, not a shared default', () => {
    const colors = Array.from({ length: 6 }, (_, type) => cloudStyleFor(type).color.join(','));
    expect(new Set(colors).size).toBe(6);
  });

  it('Cumulonimbus (4) renders denser AND darker than Cirrus (5)', () => {
    const cumulonimbus = cloudStyleFor(4);
    const cirrus = cloudStyleFor(5);
    expect(cumulonimbus.densityScale).toBeGreaterThan(cirrus.densityScale); // denser
    expect(luminance(cumulonimbus.color)).toBeLessThan(luminance(cirrus.color)); // darker
  });

  it('clamps an out-of-range index to Cumulus (1) rather than throwing — mirrors biomeColor', () => {
    const cumulus = cloudStyleFor(1);
    expect(cloudStyleFor(6)).toEqual(cumulus);
    expect(cloudStyleFor(-1)).toEqual(cumulus);
    expect(cloudStyleFor(1.5)).toEqual(cumulus);
  });
});

describe('luminance', () => {
  it('is the mean of the three channels', () => {
    expect(luminance([1, 0, 0])).toBeCloseTo(1 / 3);
    expect(luminance([1, 1, 1])).toBe(1);
    expect(luminance([0, 0, 0])).toBe(0);
  });
});

describe('weightedIndex', () => {
  it('picks index 0 for any sample within the first candidate\'s cumulative-weight span', () => {
    expect(weightedIndex([0.95, 1.0], 0)).toBe(0);
    expect(weightedIndex([0.95, 1.0], 0.5)).toBe(0);
    expect(weightedIndex([0.95, 1.0], 0.94)).toBe(0);
  });

  it('picks the next index once the sample exceeds the prior cumulative weight', () => {
    expect(weightedIndex([0.95, 1.0], 0.96)).toBe(1);
    expect(weightedIndex([0.95, 1.0], 1.0)).toBe(1);
  });

  it('a heavier candidate claims a proportionally larger share of the sample range — the mechanism behind "particle density seeded from weatherPropensity"', () => {
    // Three candidates, weights 1, 1, 8 (cumulative 1, 2, 10): the heavy
    // third candidate should win ~80% of a sweep across [0, 10).
    const cumulative = [1, 2, 10];
    const trials = 1000;
    let heavyWins = 0;
    for (let i = 0; i < trials; i++) {
      const sample = (i / trials) * 10; // deterministic sweep, not Math.random — no flake risk
      if (weightedIndex(cumulative, sample) === 2) heavyWins++;
    }
    expect(heavyWins / trials).toBeCloseTo(0.8, 1);
  });

  it('an equal-weight sweep splits evenly across candidates', () => {
    const cumulative = [1, 2, 3, 4];
    const counts = [0, 0, 0, 0];
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      counts[weightedIndex(cumulative, (i / trials) * 4)]!++;
    }
    // Bucket boundaries can land exactly on an integer sample, tipping one
    // count by one; the point is an even SPLIT, not exact equality.
    for (const c of counts) expect(c).toBeCloseTo(trials / 4, -1);
  });
});
