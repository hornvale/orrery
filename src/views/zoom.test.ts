import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dollyLookAt, dollyPosition, easeInOutCubic, lerp, lerpVector3, wheelHandoff, ZoomController } from './zoom';

describe('easeInOutCubic', () => {
  it('is 0 at 0 and 1 at 1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });
  it('is symmetric about the midpoint', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOutCubic(1 - t)).toBeCloseTo(1 - easeInOutCubic(t), 10);
    }
  });
  it('clamps out-of-range input instead of extrapolating', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
  it('eases slower than linear near both ends', () => {
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});

describe('lerp', () => {
  it('returns a at t=0 and b at t=1', () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 1)).toBe(10);
  });
  it('is linear at the midpoint', () => {
    expect(lerp(2, 10, 0.5)).toBe(6);
  });
});

describe('lerpVector3', () => {
  it('interpolates componentwise', () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(10, -4, 2);
    const m = lerpVector3(a, b, 0.5);
    expect(m.x).toBeCloseTo(5);
    expect(m.y).toBeCloseTo(-2);
    expect(m.z).toBeCloseTo(1);
  });
});

describe('ZoomController', () => {
  it('starts fully at system (value 0)', () => {
    const z = new ZoomController(1000);
    expect(z.stateAt(0)).toEqual({ value: 0, systemOpacity: 1, globeOpacity: 0 });
  });
  it('eases fully to globe once the duration elapses, and clamps past it', () => {
    const z = new ZoomController(1000);
    z.setTarget('globe', 0);
    expect(z.valueAt(0)).toBeCloseTo(0, 10);
    expect(z.valueAt(1000)).toBeCloseTo(1, 10);
    expect(z.valueAt(2000)).toBeCloseTo(1, 10);
    const settled = z.stateAt(1000);
    expect(settled.value).toBeCloseTo(1, 10);
    expect(settled.systemOpacity).toBeCloseTo(0, 10);
    expect(settled.globeOpacity).toBeCloseTo(1, 10);
  });
  it('re-targeting mid-transition eases onward from the current value, not from 0 or a jump', () => {
    const z = new ZoomController(1000);
    z.setTarget('globe', 0);
    const midValue = z.valueAt(500);
    expect(midValue).toBeGreaterThan(0);
    expect(midValue).toBeLessThan(1);
    z.setTarget('system', 500); // change of mind partway through
    expect(z.valueAt(500)).toBeCloseTo(midValue, 10); // no jump at the retarget instant
    expect(z.valueAt(1500)).toBeCloseTo(0, 10); // eases the rest of the way back
  });
  it('setTarget to the already-current target is a no-op', () => {
    const z = new ZoomController(1000);
    z.setTarget('globe', 0);
    z.setTarget('globe', 500); // already headed to globe; must not reset the start time
    expect(z.valueAt(1000)).toBeCloseTo(1, 10); // still keyed off the original start at 0
  });
  it('jumpTo snaps with no transition', () => {
    const z = new ZoomController(1000);
    z.jumpTo('globe');
    expect(z.stateAt(0)).toEqual({ value: 1, systemOpacity: 0, globeOpacity: 1 });
    expect(z.currentTarget()).toBe('globe');
  });
});

describe('dollyPosition / dollyLookAt', () => {
  const systemFraming = new THREE.Vector3(0, 6, 10);
  const worldPos = new THREE.Vector3(3, 0, 0);
  const closeOffset = new THREE.Vector3(0, 0.2, 0.5);

  it('sits at the system framing when value=0', () => {
    const p = dollyPosition(systemFraming, worldPos, closeOffset, 0);
    expect(p.equals(systemFraming)).toBe(true);
  });
  it('sits at the close framing (world position + offset) when value=1', () => {
    const p = dollyPosition(systemFraming, worldPos, closeOffset, 1);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(0.2);
    expect(p.z).toBeCloseTo(0.5);
  });
  it('looks at the star at value=0 and the world at value=1', () => {
    expect(dollyLookAt(worldPos, 0).equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(dollyLookAt(worldPos, 1).equals(worldPos)).toBe(true);
  });
});

describe('wheelHandoff', () => {
  it('zooming in at the system floor asks for the globe', () => {
    expect(wheelHandoff('system', -1, 0.301, 0.3, 40)).toBe('to-globe');
  });
  it('zooming out at the globe ceiling asks for the system', () => {
    expect(wheelHandoff('globe', +1, 11.99, 2.3, 12)).toBe('to-system');
  });
  it('mid-range wheel is just a zoom — no handoff', () => {
    expect(wheelHandoff('system', -1, 5, 0.3, 40)).toBeNull();
    expect(wheelHandoff('globe', +1, 6, 2.3, 12)).toBeNull();
  });
  it('wheeling away from the limit never hands off', () => {
    expect(wheelHandoff('system', +1, 0.301, 0.3, 40)).toBeNull();
    expect(wheelHandoff('globe', -1, 11.99, 2.3, 12)).toBeNull();
  });
});
