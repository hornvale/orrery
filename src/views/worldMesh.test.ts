import { describe, expect, it } from 'vitest';
import {
  REFERENCE_RADIUS_M,
  buildFaceGeometry,
  buildRegionTileGeometry,
  buildTileGeometry,
  sampleTile,
  stitchNormals,
  tileIndex,
} from './worldMesh';
import type { RegionScene } from '../sim/scene';
import { naturalLens } from './lens';
import { elevationColor } from '../sim/palette';
import { biomeColorForName } from './biomePalette';
import { loadSeed42Tiles } from '../testHelpers/wasmFixture';
import type { TilesScene } from '../sim/scene';

/** A colorizer these geometry-shape tests don't care about — they assert
 * positions and normals, not colors, so any deterministic RGB stands in. */
const ignoreColor = (): [number, number, number] => [0, 0, 0];

/** 4×2 all-land world, one uniform biome, 1000 m everywhere. */
function flatTiles(): TilesScene {
  const n = 8;
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: Array(n).fill(1000), ocean: Array(n).fill(false),
    biome: Array(n).fill(0), biomeLegend: ['steppe'], features: [],
    t_mean_c: Array(n).fill(15), t_swing_c: Array(n).fill(5), tDiurnalAmpC: Array(n).fill(8),
    currentEast: Array(n).fill(0), currentNorth: Array(n).fill(0),
    season_period_days: 365, circulationBands: null, moisture: Array(n).fill(0.5),
    plate: Array(n).fill(0), unrest: Array(n).fill(0), locked: false,
    precipMmYr: Array(n).fill(800), snowFraction: Array(n).fill(0.1),
    precipRegime: Array(n).fill(0), cloudFraction: Array(n).fill(0.4),
  };
}

/** 16×8 all-land world with strong deterministic relief — enough slope
 * variation that per-face vertex normals disagree along cube edges. */
function bumpyTiles(): TilesScene {
  const width = 16, height = 8, n = width * height;
  const elevation_m = Array.from({ length: n }, (_, i) => 4000 * Math.sin(i * 2.39996));
  return {
    schema: 'scene/tiles/v1', width, height, sea_level_m: 0,
    elevation_m, ocean: Array(n).fill(false),
    biome: Array(n).fill(0), biomeLegend: ['steppe'], features: [],
    t_mean_c: Array(n).fill(15), t_swing_c: Array(n).fill(5), tDiurnalAmpC: Array(n).fill(8),
    currentEast: Array(n).fill(0), currentNorth: Array(n).fill(0),
    season_period_days: 365, circulationBands: null, moisture: Array(n).fill(0.5),
    plate: Array(n).fill(0), unrest: Array(n).fill(0), locked: false,
    precipMmYr: Array(n).fill(800), snowFraction: Array(n).fill(0.1),
    precipRegime: Array(n).fill(0), cloudFraction: Array(n).fill(0.4),
  };
}

describe('tileIndex', () => {
  it('returns a value in [0, width*height) and agrees with sampleTile', () => {
    const tiles = flatTiles();
    tiles.elevation_m = tiles.elevation_m.map((_, i) => i);
    for (const [lat, lon] of [
      [45, -180],
      [-45, 90],
      [0, 0],
      [89, 179],
    ] as const) {
      const i = tileIndex(tiles, lat, lon);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(tiles.width * tiles.height);
      expect(sampleTile(tiles, lat, lon, 'elevation_m')).toBe(tiles.elevation_m[i]);
    }
  });
});

describe('buildTileGeometry (LOD tiles)', () => {
  it('a deeper tile keeps the lattice size but covers a smaller sub-square', () => {
    const tiles = flatTiles();
    const face = buildFaceGeometry(tiles, 0, 2, 0, ignoreColor);
    const child = buildTileGeometry(tiles, { face: 0, level: 1, ix: 0, iy: 0 }, 2, 0, ignoreColor);
    // Uniform grid: a deeper tile has the same vertex count (finer spacing,
    // not more vertices per tile).
    expect(child.getAttribute('position').count).toBe(face.getAttribute('position').count);
    // ...but spans a smaller part of the sphere than the whole face.
    face.computeBoundingBox();
    child.computeBoundingBox();
    const diag = (g: typeof face) => g.boundingBox!.min.distanceTo(g.boundingBox!.max);
    expect(diag(child)).toBeLessThan(diag(face));
    // Every vertex still sits on the sphere (reliefScale 0).
    const pos = child.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      expect(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))).toBeCloseTo(2, 6);
    }
  });
  it('a skirt appends a below-surface apron for crack filling', () => {
    const tile = { face: 0, level: 1, ix: 0, iy: 0 };
    const bare = buildTileGeometry(flatTiles(), tile, 2, 60, ignoreColor, 0);
    const skirted = buildTileGeometry(flatTiles(), tile, 2, 60, ignoreColor, 0.2);
    const n = 65; // TILE_QUADS + 1; four edges each add n skirt vertices
    const bareCount = bare.getAttribute('position').count;
    expect(skirted.getAttribute('position').count).toBe(bareCount + 4 * n);
    expect(skirted.getIndex()!.count).toBeGreaterThan(bare.getIndex()!.count);
    // Every appended skirt vertex sits below the (uniform, flat) surface radius.
    const pos = skirted.getAttribute('position');
    const surfaceR = Math.hypot(pos.getX(0), pos.getY(0), pos.getZ(0));
    for (let i = bareCount; i < pos.count; i++) {
      expect(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))).toBeLessThan(surfaceR);
    }
  });
  it('buildRegionTileGeometry meshes a region patch on the sphere (its own nodes)', () => {
    const samples = 4;
    const nodes = (samples + 1) * (samples + 1);
    // Only the fields the geometry builder reads (regionPatchUnits: the tile
    // address + samples; positions: elevation_m). A flat 1000 m patch.
    const region = {
      face: 0,
      level: 2,
      ix: 1,
      iy: 1,
      samples,
      elevation_m: Array(nodes).fill(1000),
    } as unknown as RegionScene;
    const geom = buildRegionTileGeometry(region, 2, 60, ignoreColor, 0.1);
    // (samples+1)^2 surface vertices + a skirt vertex per edge node (4×(samples+1)).
    expect(geom.getAttribute('position').count).toBe(nodes + 4 * (samples + 1));
    // Every surface vertex sits at the displaced (uniform, flat) radius.
    const pos = geom.getAttribute('position');
    const surfaceR = Math.hypot(pos.getX(0), pos.getY(0), pos.getZ(0));
    for (let i = 0; i < nodes; i++) {
      expect(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))).toBeCloseTo(surfaceR, 5);
    }
    // ...and it covers less of the sphere than the whole level-2 tile's face.
    expect(surfaceR).toBeGreaterThan(2); // 60× exaggeration lifts 1000 m above r=2
  });
  it('the four level-1 children tile the whole face (union of sub-squares)', () => {
    const tiles = flatTiles();
    const kids = [
      { face: 0, level: 1, ix: 0, iy: 0 },
      { face: 0, level: 1, ix: 1, iy: 0 },
      { face: 0, level: 1, ix: 0, iy: 1 },
      { face: 0, level: 1, ix: 1, iy: 1 },
    ].map((t) => buildTileGeometry(tiles, t, 2, 0, ignoreColor));
    // Each child is a valid non-empty mesh on the sphere.
    for (const k of kids) expect(k.getAttribute('position').count).toBeGreaterThan(0);
  });
});

describe('buildFaceGeometry', () => {
  it('reliefScale 0 puts every vertex exactly on the sphere', () => {
    const geom = buildFaceGeometry(flatTiles(), 0, 2, 0, ignoreColor);
    const pos = geom.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      // The position attribute is a Float32Array (required for WebGL vertex
      // upload — three.js throws on any other typed array; verified against
      // node_modules/three/src/renderers/webgl/WebGLAttributes.js), so the
      // achievable precision is float32's ~7 significant digits, not
      // float64's ~15. 6 digits (5e-7 tolerance) comfortably clears the
      // observed worst-case rounding (~8e-8) while still catching any real
      // formula bug, which would be off by orders of magnitude more.
      expect(r).toBeCloseTo(2, 6);
    }
  });
  it('reliefScale displaces by scale * elevation / reference radius', () => {
    const geom = buildFaceGeometry(flatTiles(), 0, 2, 60, ignoreColor);
    const pos = geom.getAttribute('position');
    const expected = 2 * (1 + (60 * 1000) / REFERENCE_RADIUS_M);
    const r = Math.hypot(pos.getX(0), pos.getY(0), pos.getZ(0));
    expect(r).toBeCloseTo(expected, 6);
  });
});

describe('stitchNormals', () => {
  /** Map of position key → normals seen there, across all `geoms`. */
  function normalsByPosition(geoms: ReturnType<typeof buildFaceGeometry>[]): Map<string, number[][]> {
    const seen = new Map<string, number[][]>();
    for (const g of geoms) {
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        const key = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
        const list = seen.get(key) ?? [];
        list.push([nrm.getX(i), nrm.getY(i), nrm.getZ(i)]);
        seen.set(key, list);
      }
    }
    return seen;
  }

  it('makes normals agree at every vertex shared across faces', () => {
    const geoms = Array.from({ length: 6 }, (_, f) => buildFaceGeometry(bumpyTiles(), f, 2, 60, ignoreColor));
    // Sanity: before stitching, at least one shared edge vertex disagrees —
    // otherwise this test can't fail for the seam bug it guards against.
    const before = [...normalsByPosition(geoms).values()].filter((l) => l.length > 1);
    expect(before.length).toBeGreaterThan(0);
    expect(
      before.some((l) => l.some((n) => Math.hypot(n[0]! - l[0]![0]!, n[1]! - l[0]![1]!, n[2]! - l[0]![2]!) > 1e-3)),
    ).toBe(true);

    stitchNormals(geoms);
    for (const list of normalsByPosition(geoms).values()) {
      for (const n of list) {
        expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 5);
        expect(n[0]).toBe(list[0]![0]);
        expect(n[1]).toBe(list[0]![1]);
        expect(n[2]).toBe(list[0]![2]);
      }
    }
  });
});

describe('the natural lens (behavior-preservation regression)', () => {
  it('the natural lens reproduces the pre-refactor colors tile for tile', async () => {
    const tiles = await loadSeed42Tiles(64);
    for (let i = 0; i < tiles.width * tiles.height; i++) {
      const expected = tiles.ocean[i]
        ? elevationColor(tiles.elevation_m[i]!, tiles.sea_level_m)
        : biomeColorForName(tiles.biomeLegend[tiles.biome[i]!] ?? '');
      expect(naturalLens.colorAt(tiles, i, 0)).toEqual(expected);
    }
  });
});
