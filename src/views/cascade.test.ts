import { describe, expect, it } from 'vitest';
import { CASCADE_MAX_IN_FLIGHT, createCascade } from './cascade';
import { tileCenterUnit, tileKey, type TileId } from './cubeSphere';

const t = (face: number, level = 0, ix = 0, iy = 0): TileId => ({ face, level, ix, iy });

describe('cascade scheduler', () => {
  it('hands out no more than the in-flight cap at once', () => {
    const c = createCascade();
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    expect(c.next().length).toBe(CASCADE_MAX_IN_FLIGHT);
    expect(c.next().length).toBe(0); // cap is saturated until something settles
  });

  it('releases capacity as tiles settle', () => {
    const c = createCascade({ maxInFlight: 2 });
    c.submit([t(0), t(1), t(2)]);
    const first = c.next();
    expect(first.length).toBe(2);
    c.settle(first[0]!);
    expect(c.next().length).toBe(1);
  });

  it('orders camera-facing tiles first', () => {
    const c = createCascade({ maxInFlight: 6 });
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    // Face 1's centre, as the camera direction: face 1 must come out first.
    c.reprioritize(tileCenterUnit(t(1)));
    const order = c.next().map(tileKey);
    expect(order[0]).toBe(tileKey(t(1)));
  });

  it('reprioritizes a partially drained queue without redealing in-flight tiles', () => {
    const c = createCascade({ maxInFlight: 2 });
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    const dealt = c.next();
    const dealtKeys = dealt.map(tileKey);
    c.reprioritize(tileCenterUnit(t(5)));
    for (const d of dealt) c.settle(d); // free both slots
    const after = c.next().map(tileKey);
    // The re-sorted queue leads with face 5, and nothing already dealt recurs.
    expect(after[0]).toBe(tileKey(t(5)));
    for (const k of after) expect(dealtKeys).not.toContain(k);
  });

  it('never deals the same tile twice', () => {
    const c = createCascade({ maxInFlight: 10 });
    c.submit([t(0), t(1)]);
    c.submit([t(0), t(1)]); // duplicate submit is a no-op
    const dealt = c.next();
    expect(dealt.length).toBe(2);
    expect(c.pending).toBe(0);
  });

  it('exhausts exactly once: a settled tile is not re-dealt', () => {
    const c = createCascade({ maxInFlight: 4 });
    c.submit([t(0), t(1)]);
    const dealt = c.next();
    for (const d of dealt) c.settle(d);
    expect(c.next()).toEqual([]);
    expect(c.pending).toBe(0);
    expect(c.inFlight).toBe(0);
  });
});
