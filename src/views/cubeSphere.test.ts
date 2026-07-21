import { describe, expect, it } from 'vitest';
import {
  LOD_CDLOD_MAX_LEVEL, LOD_MAX_LEVEL, LOD_MERGE_FACTOR, LOD_MIN_LEVEL, LOD_SPLIT_FACTOR, TILE_QUADS,
  children, containingTile, faceUnit,
  globeLodLevel, maxLevel, parent, selectTiles, splitAncestorKeys,
  tileCenterUnit, tileEdgeLenM, tileGrid, tileKey, unitLatLon, type TileId, type V3,
} from './cubeSphere';

describe('cubeSphere addressing', () => {
  it('faceUnit covers the sphere: 6 faces × corners are unit-length and distinct-ish', () => {
    const seen = new Set<string>();
    for (let f = 0; f < 6; f++) {
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as const) {
        const u = faceUnit(f, a, b);
        expect(Math.hypot(...u)).toBeCloseTo(1, 12);
        seen.add(u.map((x) => x.toFixed(6)).join(','));
      }
    }
    expect(seen.size).toBe(6 + 8); // 6 distinct centers + 8 shared corners
  });

  it('adjacent faces produce bit-identical points along shared edges', () => {
    // +X face at a=1 runs along the cube edge x=1,y=1; find the neighbor
    // face/param that generates the same edge, and compare EXACTLY (===).
    for (let i = 0; i <= 8; i++) {
      const b = -1 + (2 * i) / 8;
      const fromX = faceUnit(0, 1, b);
      const fromY = faceUnit(2, -1, b);
      expect(fromX[0]).toBe(fromY[0]);
      expect(fromX[1]).toBe(fromY[1]);
      expect(fromX[2]).toBe(fromY[2]);
    }
  });

  it('unitLatLon inverts the terrain lat/lon convention', () => {
    const u = faceUnit(4, 0, 0); // +Z face center = north pole
    expect(unitLatLon(u).latDeg).toBeCloseTo(90, 10);
    const eq = faceUnit(0, 0, 0); // +X face center = lat 0, lon 0
    const { latDeg, lonDeg } = unitLatLon(eq);
    expect(latDeg).toBeCloseTo(0, 10);
    expect(lonDeg).toBeCloseTo(0, 10);
  });

  it('children/parent round-trip and refine the same square', () => {
    const t: TileId = { face: 3, level: 4, ix: 5, iy: 9 };
    const kids = children(t);
    expect(kids.length).toBe(4);
    for (const k of kids) {
      expect(k.level).toBe(5);
      expect(parent(k)).toEqual(t);
    }
    expect(new Set(kids.map(tileKey)).size).toBe(4);
    expect(parent({ face: 0, level: 0, ix: 0, iy: 0 })).toBeNull();
  });

  it('tileGrid yields (N+1)² aligned lat/lon/unit samples with exact shared edges', () => {
    const t: TileId = { face: 1, level: 2, ix: 1, iy: 2 };
    const g = tileGrid(t);
    const n = TILE_QUADS + 1;
    expect(g.lats.length).toBe(n * n);
    expect(g.units.length).toBe(3 * n * n);
    // right edge of this tile === left edge of its east neighbor (same level)
    const nb: TileId = { face: 1, level: 2, ix: 2, iy: 2 };
    const gn = tileGrid(nb);
    for (let row = 0; row < n; row++) {
      const a = row * n + (n - 1); // last column of t
      const bIdx = row * n + 0;    // first column of neighbor
      expect(g.units[3 * a]).toBe(gn.units[3 * bIdx]);
      expect(g.units[3 * a + 1]).toBe(gn.units[3 * bIdx + 1]);
      expect(g.units[3 * a + 2]).toBe(gn.units[3 * bIdx + 2]);
    }
  });

  it('edge length halves per level; maxLevel lands near 1.5 m spacing', () => {
    const R = 6.371e6;
    expect(tileEdgeLenM(3, R)).toBeCloseTo(tileEdgeLenM(2, R) / 2, 6);
    const L = maxLevel(R);
    const spacing = tileEdgeLenM(L, R) / TILE_QUADS;
    expect(spacing).toBeGreaterThan(0.7);
    expect(spacing).toBeLessThan(3.0);
    expect(maxLevel(1e4)).toBeGreaterThanOrEqual(3); // tiny body clamps low but valid
  });

  it('containingTile finds the tile whose square holds the point', () => {
    const t: TileId = { face: 2, level: 6, ix: 17, iy: 40 };
    const c = tileCenterUnit(t);
    expect(containingTile(c, 6)).toEqual(t);
  });
});

describe('globeLodLevel', () => {
  const r = 2;
  it('is the base level far away and never leaves [MIN, MAX]', () => {
    expect(globeLodLevel(10 * r, r)).toBe(LOD_MIN_LEVEL);
    expect(globeLodLevel(4 * r, r)).toBe(LOD_MIN_LEVEL);
    for (const d of [10 * r, 2 * r, 1.5 * r, 1.1 * r, 1.001 * r]) {
      const lvl = globeLodLevel(d, r);
      expect(lvl).toBeGreaterThanOrEqual(LOD_MIN_LEVEL);
      expect(lvl).toBeLessThanOrEqual(LOD_MAX_LEVEL);
    }
  });
  it('rises monotonically as the camera nears the surface, capping at MAX', () => {
    let prev = 0;
    for (const d of [4 * r, 2 * r, 1.5 * r, 1.25 * r, 1.1 * r, 1.01 * r]) {
      const lvl = globeLodLevel(d, r);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
    expect(globeLodLevel(1.0001 * r, r)).toBe(LOD_MAX_LEVEL);
  });
});

describe('selectTiles (CDLOD)', () => {
  const r = 2;
  it('a far camera leaves the six coarse level-0 faces', () => {
    const far = selectTiles([100, 0, 0], r);
    expect(far.length).toBe(6);
    expect(far.every((t) => t.level === 0)).toBe(true);
  });
  it('a close camera deepens the tiles it faces, leaving the far side coarser', () => {
    // Just above the +X face (face 0's normal is +X); face 1 is the far side.
    const near = selectTiles([r * 1.05, 0, 0], r);
    expect(near.length).toBeGreaterThan(6);
    const levelOn = (face: number) => Math.max(...near.filter((t) => t.face === face).map((t) => t.level));
    expect(levelOn(0)).toBeGreaterThan(levelOn(1)); // camera-facing side is finer
  });
  it('never exceeds maxLevel', () => {
    const t = selectTiles([r * 1.001, 0, 0], r, 3, 2);
    expect(Math.max(...t.map((x) => x.level))).toBeLessThanOrEqual(2);
  });

  it('LOD_CDLOD_MAX_LEVEL is pinned at the deeper ceiling (The Massing, Task 6)', () => {
    // Pinned so a future change to the ceiling is deliberate, not incidental.
    expect(LOD_CDLOD_MAX_LEVEL).toBe(6);
  });

  it('at a low camera altitude, the default ceiling reaches a tile deeper than the old cap (4)', () => {
    // r * 1.02 is well within the CDLOD split threshold all the way down to
    // level 6 (1.5 × the level-5 edge length, ≈ 7.4% of r, vs. this camera's
    // ~2% altitude) — this is the deeper reach Task 6 unlocks: the old
    // LOD_CDLOD_MAX_LEVEL=4 ceiling could never be reached at any altitude,
    // and the old minDistance never let the camera get this close anyway.
    const near = selectTiles([r * 1.02, 0, 0], r);
    const maxReached = Math.max(...near.map((t) => t.level));
    expect(maxReached).toBeGreaterThan(4);
    expect(maxReached).toBeLessThanOrEqual(LOD_CDLOD_MAX_LEVEL);
  });
});

describe('LOD hysteresis', () => {
  const r = 2;

  it('splitAncestorKeys marks every strict ancestor of a leaf, never the leaf itself', () => {
    const leaf: TileId = { face: 0, level: 2, ix: 1, iy: 1 };
    const keys = splitAncestorKeys([leaf]);
    expect(keys.has(tileKey(leaf))).toBe(false);
    const p1 = parent(leaf)!;
    const p0 = parent(p1)!;
    expect(keys.has(tileKey(p1))).toBe(true);
    expect(keys.has(tileKey(p0))).toBe(true);
  });

  it('splitAncestorKeys walks each shared ancestor chain once (dedup across leaves)', () => {
    const faceRoot: TileId = { face: 0, level: 0, ix: 0, iy: 0 };
    const leaves = children(faceRoot); // 4 siblings sharing the same one ancestor
    const keys = splitAncestorKeys(leaves);
    expect(keys.size).toBe(1);
    expect(keys.has(tileKey(faceRoot))).toBe(true);
  });

  it('a previously-split tile stays subdivided past the plain split threshold (no thrash)', () => {
    // A camera sitting strictly between splitFactor·edge and mergeFactor·edge:
    // a tile that has never split stays coarse here (its ordinary threshold
    // is behind it); a tile that WAS split last frame must not merge back
    // yet (its threshold is the wider mergeFactor, still ahead of it).
    const faceRoot: TileId = { face: 0, level: 0, ix: 0, iy: 0 };
    const edge0 = tileEdgeLenM(0, r);
    const dist = ((LOD_SPLIT_FACTOR + LOD_MERGE_FACTOR) / 2) * edge0;
    const camPos: V3 = [r + dist, 0, 0]; // face 0's center is at [r,0,0]

    const fresh = selectTiles(camPos, r, LOD_SPLIT_FACTOR, 4, 0);
    expect(fresh.some((t) => t.face === 0 && t.level === 0)).toBe(true); // merged/never-split: coarse

    const splitAncestors = splitAncestorKeys(children(faceRoot)); // face 0 was split last frame
    const held = selectTiles(camPos, r, LOD_SPLIT_FACTOR, 4, 0, { mergeFactor: LOD_MERGE_FACTOR, splitAncestors });
    expect(held.some((t) => t.face === 0 && t.level === 0)).toBe(false); // held split, no thrash
    expect(held.some((t) => t.face === 0 && t.level === 1)).toBe(true);
  });

  it('an empty splitAncestors set behaves exactly like no hysteresis at all', () => {
    const edge0 = tileEdgeLenM(0, r);
    const dist = ((LOD_SPLIT_FACTOR + LOD_MERGE_FACTOR) / 2) * edge0;
    const camPos: V3 = [r + dist, 0, 0];
    const plain = selectTiles(camPos, r, LOD_SPLIT_FACTOR, 4, 0);
    const withEmptyHysteresis = selectTiles(camPos, r, LOD_SPLIT_FACTOR, 4, 0, {
      mergeFactor: LOD_MERGE_FACTOR,
      splitAncestors: new Set<string>(),
    });
    expect(withEmptyHysteresis.map(tileKey).sort()).toEqual(plain.map(tileKey).sort());
  });

  it('past the merge threshold, a previously-split tile merges back too', () => {
    const faceRoot: TileId = { face: 0, level: 0, ix: 0, iy: 0 };
    const edge0 = tileEdgeLenM(0, r);
    const dist = (LOD_MERGE_FACTOR + 0.5) * edge0; // well past even the wider threshold
    const camPos: V3 = [r + dist, 0, 0];
    const splitAncestors = splitAncestorKeys(children(faceRoot));
    const merged = selectTiles(camPos, r, LOD_SPLIT_FACTOR, 4, 0, { mergeFactor: LOD_MERGE_FACTOR, splitAncestors });
    expect(merged.some((t) => t.face === 0 && t.level === 0)).toBe(true);
  });
});
