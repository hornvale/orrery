import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MARGIN, bandVisibleAt, buildEclipseBand } from './eclipseBand';
import type { EclipseEvent, GroundTrack } from '../sim/scene';

const solarAt = (day: number): EclipseEvent => ({
  day,
  moonIndex: 0,
  body: 'solar',
  kind: 'total',
  track: { centerLatDeg: 0, halfWidthDeg: 1, startLonDeg: -10, endLonDeg: 10, durationDays: 0.1 },
});

const lunarAt = (day: number): EclipseEvent => ({
  day,
  moonIndex: 0,
  body: 'lunar',
  kind: 'total',
  track: null,
});

describe('MARGIN', () => {
  it('is pinned at 3 days', () => {
    expect(MARGIN).toBe(3);
  });
});

describe('bandVisibleAt', () => {
  it('is true for a solar event within the margin of day (either side, and exactly at it)', () => {
    expect(bandVisibleAt(solarAt(100), 100, MARGIN)).toBe(true);
    expect(bandVisibleAt(solarAt(100), 103, MARGIN)).toBe(true);
    expect(bandVisibleAt(solarAt(100), 97, MARGIN)).toBe(true);
  });

  it('is false for a lunar event, even exactly at its day', () => {
    expect(bandVisibleAt(lunarAt(100), 100, MARGIN)).toBe(false);
  });

  it('is false for a solar event far from day', () => {
    expect(bandVisibleAt(solarAt(100), 200, MARGIN)).toBe(false);
    expect(bandVisibleAt(solarAt(100), 104, MARGIN)).toBe(false);
  });
});

describe('buildEclipseBand', () => {
  // A wide track crossing the antimeridian, so the arc-wrap and lat-edge
  // math both get exercised together.
  const track: GroundTrack = {
    centerLatDeg: 10,
    halfWidthDeg: 2,
    startLonDeg: 170,
    endLonDeg: -170,
    durationDays: 0.1,
  };
  const radius = 2;

  function latLonOf(pos: THREE.BufferAttribute, i: number): { lat: number; lon: number } {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.sqrt(x * x + y * y + z * z);
    return { lat: (Math.asin(z / r) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI };
  }

  it('returns a THREE.Mesh', () => {
    expect(buildEclipseBand(track, radius)).toBeInstanceOf(THREE.Mesh);
  });

  it('every vertex lies within [centerLat - halfWidth, centerLat + halfWidth]', () => {
    const mesh = buildEclipseBand(track, radius);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const eps = 1e-4;
    for (let i = 0; i < pos.count; i++) {
      const { lat } = latLonOf(pos, i);
      expect(lat).toBeGreaterThanOrEqual(track.centerLatDeg - track.halfWidthDeg - eps);
      expect(lat).toBeLessThanOrEqual(track.centerLatDeg + track.halfWidthDeg + eps);
    }
  });

  it('every vertex sits at radius * 1.001 (just above the surface)', () => {
    const mesh = buildEclipseBand(track, radius);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = Math.sqrt(x * x + y * y + z * z);
      expect(r).toBeCloseTo(radius * 1.001, 6);
    }
  });

  it('spans the start→end arc: first step at startLon, last step at endLon', () => {
    const mesh = buildEclipseBand(track, radius);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const first = latLonOf(pos, 0); // low(s=0)
    const last = latLonOf(pos, pos.count - 2); // low(s=LON_STEPS)
    expect(first.lon).toBeCloseTo(track.startLonDeg, 3);
    expect(last.lon).toBeCloseTo(track.endLonDeg, 3);
  });

  it('takes the signed-shortest arc (20° eastward through the antimeridian, not 340° the other way)', () => {
    const mesh = buildEclipseBand(track, radius);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    // The midpoint step (t=0.5) should sit near lon 180 (170 + 10), not
    // somewhere on the long way round through lon 0.
    const mid = latLonOf(pos, pos.count / 2 - 2); // low vertex of the middle step
    expect(Math.abs(mid.lon)).toBeGreaterThan(170);
  });

  it('does not span the whole 360° when start === end (degenerate arc collapses to a point band)', () => {
    const point: GroundTrack = { ...track, endLonDeg: track.startLonDeg };
    const mesh = buildEclipseBand(point, radius);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const first = latLonOf(pos, 0);
    const last = latLonOf(pos, pos.count - 2);
    expect(last.lon).toBeCloseTo(first.lon, 3);
  });

  it('is a semi-transparent, non-depth-writing basic material', () => {
    const mesh = buildEclipseBand(track, radius);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.4);
    expect(mat.depthWrite).toBe(false);
  });
});
