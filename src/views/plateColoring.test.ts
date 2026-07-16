import { beforeAll, describe, expect, it } from 'vitest';
import { PLATE_SLOTS, colorPlates, isBoundaryTile, plateAdjacency } from './plateColoring';
import { loadSeed42Tiles } from '../testHelpers/wasmFixture';
import type { TilesScene } from '../sim/scene';

// See lens.test.ts's beforeAll comment: loadSeed42Tiles(64) already memoizes
// per-argument, so this hook just gives the one real wasm cost a single,
// predictable home (a hook, with its own timeout) instead of paying it
// inline in whichever test happens to run first.
let seed42Tiles: TilesScene;
beforeAll(async () => {
  seed42Tiles = await loadSeed42Tiles(64);
}, 45000);

/** A 4×2 lattice, two plates split down the middle. Only the fields the
 * coloring reads matter; note col 3 borders col 0 through the wrap. */
const stripes = (): TilesScene =>
  ({ width: 4, height: 2, plate: [0, 0, 1, 1, 0, 0, 1, 1] }) as never;

/** A 4×2 lattice of four plates in a ring — every plate borders two others. */
const ring = (): TilesScene =>
  ({ width: 4, height: 2, plate: [0, 1, 2, 3, 0, 1, 2, 3] }) as never;

describe('plateAdjacency', () => {
  it('finds the borders, longitude wrapping included', () => {
    const adj = plateAdjacency(stripes());
    expect(adj.get(0)).toEqual(new Set([1])); // touches 1 mid-row AND across the seam
    expect(adj.get(1)).toEqual(new Set([0]));
  });

  it('records the wrap seam specifically', () => {
    // Plates 3 and 0 touch ONLY across the antimeridian; if the wrap is
    // dropped they look non-adjacent and may draw the same color.
    expect(plateAdjacency(ring()).get(3)).toContain(0);
  });

  it('never records a plate as its own neighbour', () => {
    const adj = plateAdjacency(seed42Tiles);
    for (const [id, ns] of adj) expect(ns.has(id), `plate ${id}`).toBe(false);
  });
});

describe('colorPlates', () => {
  it('gives adjacent plates different slots — the whole point', () => {
    const tiles = seed42Tiles;
    const colors = colorPlates(tiles);
    for (const [id, neighbours] of plateAdjacency(tiles)) {
      for (const n of neighbours) {
        expect(colors.get(id), `plate ${id} vs its neighbour ${n}`).not.toBe(colors.get(n));
      }
    }
  });

  it('needs no more than the six slots (degeneracy bound on a planar map)', () => {
    const colors = colorPlates(seed42Tiles);
    for (const slot of colors.values()) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PLATE_SLOTS.length);
    }
  });

  it('colors every plate present', () => {
    const tiles = seed42Tiles;
    expect(colorPlates(tiles).size).toBe(new Set(tiles.plate).size);
  });

  it('is deterministic', () => {
    const tiles = seed42Tiles;
    expect([...colorPlates(tiles)]).toEqual([...colorPlates(tiles)]);
  });
});

describe('isBoundaryTile', () => {
  it('marks the seam between two plates', () => {
    const t = stripes();
    expect(isBoundaryTile(t, 1)).toBe(true); // col 1 borders col 2 (plate 1)
    expect(isBoundaryTile(t, 2)).toBe(true); // col 2 borders col 1 (plate 0)
    expect(isBoundaryTile(t, 0)).toBe(true); // col 0 wraps to col 3 (plate 1)
  });

  it('leaves a single-plate world with no boundaries at all', () => {
    const t = { width: 4, height: 2, plate: [0, 0, 0, 0, 0, 0, 0, 0] } as never;
    for (let i = 0; i < 8; i++) expect(isBoundaryTile(t, i)).toBe(false);
  });
});
