import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  REFERENCE_RADIUS_M,
  VOXEL_CLIFF_DARKEN,
  buildFaceGeometry,
  buildRegionTileGeometry,
  buildTileGeometry,
  buildVoxelHeightfieldGeometry,
  buildVoxelRegionTileGeometry,
  buildVoxelRegionTileGeometryIndexed,
  buildVoxelTileGeometry,
  buildVoxelTileGeometryIndexed,
  quantizeBands,
  sampleElevationBilinear,
  sampleTile,
  stitchNormals,
  tileIndex,
} from './worldMesh';
import type { RegionScene } from '../sim/scene';
import { majorWaterColor, naturalLens } from './lens';
import { elevationColor } from '../sim/palette';
import { biomeColorForName } from './biomePalette';
import { loadSeed42Tiles } from '../testHelpers/wasmFixture';
import type { TilesScene } from '../sim/scene';
import { regionPatchUnits } from './regionPatch';
import { unitLatLon } from './cubeSphere';

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
    weatherPropensity: Array(n).fill(0.6), cloudType: Array(n).fill(0),
    water: Array(n).fill(3), waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    drainage: Array(n).fill(0), waterfalls: [],
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
    weatherPropensity: Array(n).fill(0.6), cloudType: Array(n).fill(0),
    water: Array(n).fill(3), waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    drainage: Array(n).fill(0), waterfalls: [],
  };
}

/** A flat (zero-elevation) world — for the "analytic normals are radial on a
 * flat patch" test. Any relief-detecting probe should read pure-sphere
 * normals here regardless of the probe delta chosen. */
function flatZeroTiles(): TilesScene {
  return { ...flatTiles(), elevation_m: Array(8).fill(0) };
}

/** A steep-sawtooth world: elevation ramps 0→3000m every 1° of longitude
 * (4 columns of the 0.25°/cell grid), on a grid fine enough (1440 cols) that
 * the analytic-normal probe delta (0.2°, `NORMAL_PROBE_DELTA_DEG` in
 * worldMesh.ts) reliably crosses a real elevation step — with a per-degree
 * slope steep enough (3000 m/°) to produce a normal tilt well above the
 * flat-patch tolerance, not just a few noise-level ULPs. `bumpyTiles` (16
 * cols → 22.5°/cell) is far too coarse for that probe to see any slope. */
function slopedTiles(): TilesScene {
  const width = 1440, height = 2, n = width * height;
  const elevation_m = Array.from({ length: n }, (_, i) => 3000 * (((i % width) % 4) / 4));
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
    weatherPropensity: Array(n).fill(0.6), cloudType: Array(n).fill(0),
    water: Array(n).fill(3), waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    drainage: Array(n).fill(0), waterfalls: [],
  };
}

/** A fine (1°/cell) equirect world whose elevation is a clean quadrant step:
 * 5000 m wherever BOTH lat>0 and lon>0, 0 m everywhere else. `face: 0` is the
 * equatorial face (centered at lat=0, lon=0 — see `cubeSphere.ts`'s `FACES`
 * table), so a level-0 tile's four `cellsPerEdge: 2` cell centers land near
 * (±24°, ±26°) — one in each quadrant, comfortably away from the lat=0/lon=0
 * seams (1° pixels either side), so `sampleElevationBilinear` reads a clean
 * step at each center rather than blending across a quadrant boundary. Used
 * by `buildVoxelTileGeometry`'s tests below: with `{face:0,level:0,ix:0,iy:0}`
 * and `cellsPerEdge: 2`, exactly the (lat>0,lon>0) cell reads high — the
 * "one cell high, three low" fixture the task brief calls for. */
function stepTiles(): TilesScene {
  const width = 360, height = 180, n = width * height;
  const elevation_m: number[] = new Array(n);
  for (let row = 0; row < height; row++) {
    const lat = 90 - (row + 0.5) * (180 / height);
    for (let col = 0; col < width; col++) {
      const lon = -180 + (col + 0.5) * (360 / width);
      elevation_m[row * width + col] = lat > 0 && lon > 0 ? 5000 : 0;
    }
  }
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
    weatherPropensity: Array(n).fill(0.6), cloudType: Array(n).fill(0),
    water: Array(n).fill(3), waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    drainage: Array(n).fill(0), waterfalls: [],
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

describe('sampleElevationBilinear', () => {
  it('returns the node value at a cell center and interpolates continuously between cells', () => {
    // 4×2 grid: rowSpan 90°, colSpan 90°; values are pixel centers.
    const tiles = { width: 4, height: 2, elevation_m: [0, 100, 200, 300, 400, 500, 600, 700] } as never;
    const centerLat = (r: number): number => 90 - (r + 0.5) * 90;
    const centerLon = (c: number): number => -180 + (c + 0.5) * 90;
    // At an exact cell center, bilinear == the nearest-cell value.
    expect(sampleElevationBilinear(tiles, centerLat(0), centerLon(1))).toBeCloseTo(100, 6);
    expect(sampleElevationBilinear(tiles, centerLat(1), centerLon(2))).toBeCloseTo(600, 6);
    // Halfway between col 1 (100) and col 2 (200) on row 0 → the midpoint 150,
    // a continuous interpolation rather than the stepped 100-or-200 nearest
    // sample whose gradient spikes the analytic normal under 60× relief.
    expect(sampleElevationBilinear(tiles, centerLat(0), (centerLon(1) + centerLon(2)) / 2)).toBeCloseTo(150, 6);
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

describe('quantizeBands', () => {
  it('snaps elevation down to its band floor', () => {
    expect(quantizeBands(0, 200)).toBe(0);
    expect(quantizeBands(199, 200)).toBe(0);
    expect(quantizeBands(200, 200)).toBe(200);
    expect(quantizeBands(-1, 200)).toBe(-200); // below sea level steps down
    expect(quantizeBands(650, 200)).toBe(600);
  });
});

describe('buildTileGeometry (terraced banding)', () => {
  it('with no bandM, the radius stays continuous (today\'s Smooth path, unchanged)', () => {
    const geom = buildTileGeometry(slopedTiles(), { face: 0, level: 0, ix: 0, iy: 0 }, 2, 30, ignoreColor, 0);
    const pos = geom.getAttribute('position');
    const radii = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      radii.add(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    // The sawtooth relief has many distinct slopes, so an unbanded build sees
    // far more distinct radii than any small banded set could produce.
    expect(radii.size).toBeGreaterThan(8);
  });

  it('with a bandM, distinct radii collapse to a small finite banded set', () => {
    const bandM = 200;
    const geom = buildTileGeometry(slopedTiles(), { face: 0, level: 0, ix: 0, iy: 0 }, 2, 30, ignoreColor, 0, bandM);
    const pos = geom.getAttribute('position');
    // Positions round-trip through a Float32Array (WebGL upload requirement —
    // see the `buildFaceGeometry` sphere test above), so two vertices at the
    // exact same banded elevation can still land a few ULPs apart depending on
    // their (different) unit-vector direction. A banding step here is
    // radius·reliefScale·bandM/REFERENCE_RADIUS_M ≈ 2·30·200/6.371e6 ≈ 1.9e-3
    // — far larger than that float32 noise (~2e-7 at this magnitude) — so
    // rounding to 5 decimals collapses same-band vertices without merging
    // adjacent, distinct bands.
    const radii = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      radii.add(Number(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)).toFixed(5)));
    }
    // slopedTiles ramps 0..3000m, so at most 3000/200 + 1 = 16 distinct bands
    // are reachable — far fewer than the continuous case, and finite/small.
    expect(radii.size).toBeGreaterThan(1);
    expect(radii.size).toBeLessThanOrEqual(16);
    // Every reachable radius must correspond to a band floor — i.e. its
    // reconstructed elevation is within a hair of SOME multiple of `bandM`,
    // not sitting mid-band the way a continuous (unbanded) surface would.
    // Reversing radius back to elevation multiplies the float32-position
    // round-trip's noise by REFERENCE_RADIUS_M/reliefScale (a ~2e5
    // amplification, since REFERENCE_RADIUS_M is on the order of 1e6 and
    // reliefScale is a small integer), so the ~1e-7-relative float32 error
    // becomes order-1m here — comfortably below the 200m band, so checking
    // "near a multiple" (not band-floor-of-the-reconstruction, which a
    // boundary-adjacent noisy value could floor into the WRONG band) is the
    // robust form.
    for (const r of radii) {
      const elevM = ((r / 2 - 1) * REFERENCE_RADIUS_M) / 30;
      const remainder = ((elevM % bandM) + bandM) % bandM;
      const distToBand = Math.min(remainder, bandM - remainder);
      expect(distToBand).toBeLessThan(1);
    }
  });
});

describe('buildRegionTileGeometry (terraced banding)', () => {
  it('with a bandM, distinct radii collapse to a small finite banded set', () => {
    // buildRegionTileGeometry bands TWO elevation sources through a shared
    // `applyBand` helper: the surface position reads `region.elevation_m[i]`
    // directly, while the analytic-normal probe goes through
    // `sampleRegionElevationBilinear` — a distinct code path from the tile
    // builder's single `radiusAtLatLon` closure. This fixture ramps elevation
    // 0..3000m across `samples + 1` columns (repeated down every row), giving
    // 33 distinct raw per-node elevations — enough that an unbanded surface
    // shows far more than 16 distinct radii (mirroring `slopedTiles`' sawtooth
    // ramp, but through the region builder's own per-node field, not a
    // bilinear tiles-export resample).
    const samples = 32;
    const n = samples + 1;
    const elevation_m: number[] = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) elevation_m.push(3000 * (col / samples));
    }
    const region = { face: 0, level: 2, ix: 0, iy: 0, samples, elevation_m } as unknown as RegionScene;

    const bandM = 200;
    const geom = buildRegionTileGeometry(region, 2, 30, ignoreColor, 0, bandM);
    const pos = geom.getAttribute('position');
    // skirtDepth 0 → surface vertices only, one per region node.
    expect(pos.count).toBe(n * n);
    const radii = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      // toFixed(5) collapses same-band float32 noise without merging
      // adjacent bands — see the analogous rounding-tolerance comment on
      // `buildTileGeometry`'s banded test above.
      radii.add(Number(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)).toFixed(5)));
    }
    // The ramp reaches 33 distinct raw elevations spanning 0..3000m, so a
    // continuous (unbanded) build would show up to 33 distinct radii; banded
    // to 200m steps, at most 3000/200 + 1 = 16 band floors are reachable.
    expect(radii.size).toBeGreaterThan(1);
    expect(radii.size).toBeLessThanOrEqual(16);
  });
});

describe('buildVoxelTileGeometry', () => {
  const tile0 = { face: 0, level: 0, ix: 0, iy: 0 };

  /** Non-indexed flat-shaded geometry: one triangle per 3 position entries. */
  function triangleCount(geom: THREE.BufferGeometry): number {
    return geom.getAttribute('position').count / 3;
  }

  /** Distance from the sphere's center — used to tell a "top" vertex (all 4
   * corners of a cell's top face share one radius) from a "wall" vertex
   * (mixes its cell's radius with a lower neighbor's). */
  function radiusOf(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): number {
    return Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
  }

  /** True if any two of a triangle's 3 vertices sit at the EXACT same 3D
   * position. A wall quad between two equal-radius cells would be built
   * from a top corner and a bottom corner at the identical radius along the
   * identical unit vector — i.e. the identical point — so its two triangles
   * would be degenerate (zero area, a duplicated vertex). A correct
   * implementation never emits a wall for an equal-height neighbor, so a
   * degenerate triangle here means the emission rule regressed to `<=`. */
  function hasWallBetweenEqualCells(geom: THREE.BufferGeometry): boolean {
    const pos = geom.getAttribute('position');
    const same = (i: number, j: number): boolean =>
      Math.abs(pos.getX(i) - pos.getX(j)) < 1e-9 &&
      Math.abs(pos.getY(i) - pos.getY(j)) < 1e-9 &&
      Math.abs(pos.getZ(i) - pos.getZ(j)) < 1e-9;
    for (let t = 0; t < pos.count; t += 3) {
      if (same(t, t + 1) || same(t + 1, t + 2) || same(t, t + 2)) return true;
    }
    return false;
  }

  it('emits a top face per cell and a wall ONLY where a cell is higher than a neighbor', () => {
    const stepTilesFixture = stepTiles();
    const geom = buildVoxelTileGeometry(stepTilesFixture, tile0, 1, 1, () => [1, 1, 1], {
      cellsPerEdge: 2,
      bandM: 100,
    });
    const pos = geom.getAttribute('position');
    // 4 cells × 2 top tris = 8 top tris minimum; the single high cell
    // (lat>0, lon>0) has walls only toward its LOWER neighbors — its other
    // two edges are the tile boundary (no in-tile neighbor, so no wall) —
    // giving exactly 2 interior wall quads (4 tris).
    expect(triangleCount(geom)).toBe(8 /* tops */ + 2 * 2 /* two wall quads */);
    // No wall between two equal-height (both-low) cells.
    expect(hasWallBetweenEqualCells(geom)).toBe(false);

    // The high cell's top sits at a strictly greater radius than every low
    // cell's top — confirming the "8 tops" aren't all flat/degenerate too.
    // toFixed(5) (not more): positions are a Float32Array, so two vertices
    // at the exact same pre-quantization radius can still land a few ULPs
    // apart depending on their (different) unit-vector direction — the same
    // rounding-tolerance rationale as `buildTileGeometry`'s banding test above.
    const radii = new Set<number>();
    for (let i = 0; i < 4 * 6; i++) radii.add(Number(radiusOf(pos, i).toFixed(5)));
    expect(radii.size).toBe(2); // exactly one high band, one low band among the 4 tops
  });

  it("colors each cell flat (all of a cell's top verts share one color)", () => {
    const stepTilesFixture = stepTiles();
    const palette: Record<number, [number, number, number]> = {};
    const colorAt = (i: number): [number, number, number] => {
      palette[i] ??= [(i * 37) % 250, (i * 59) % 250, (i * 83) % 250];
      return palette[i]!;
    };
    const geom = buildVoxelTileGeometry(stepTilesFixture, tile0, 1, 1, colorAt, {
      cellsPerEdge: 2,
      bandM: 100,
    });
    const col = geom.getAttribute('color');
    // Pass 1 emits every cell's 6 top vertices contiguously, in row-major
    // (row*cellsPerEdge+col) order, before any wall — so cell `c`'s top
    // face is exactly vertices [c*6, c*6+6).
    for (let c = 0; c < 4; c++) {
      const base = c * 6;
      const r0 = col.getX(base), g0 = col.getY(base), b0 = col.getZ(base);
      for (let v = base + 1; v < base + 6; v++) {
        expect(col.getX(v)).toBeCloseTo(r0, 6);
        expect(col.getY(v)).toBeCloseTo(g0, 6);
        expect(col.getZ(v)).toBeCloseTo(b0, 6);
      }
    }
  });

  it('a wall is darkened relative to its cell\'s top color by VOXEL_CLIFF_DARKEN', () => {
    const stepTilesFixture = stepTiles();
    const geom = buildVoxelTileGeometry(stepTilesFixture, tile0, 1, 1, () => [200, 100, 40], {
      cellsPerEdge: 2,
      bandM: 100,
    });
    const pos = geom.getAttribute('position');
    const col = geom.getAttribute('color');
    // Past the 4×6=24 top vertices, every remaining vertex belongs to a
    // wall triangle and should carry the darkened color.
    const topVerts = 4 * 6;
    expect(pos.count).toBeGreaterThan(topVerts);
    for (let v = topVerts; v < pos.count; v++) {
      expect(col.getX(v) * 255).toBeCloseTo(200 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getY(v) * 255).toBeCloseTo(100 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getZ(v) * 255).toBeCloseTo(40 * VOXEL_CLIFF_DARKEN, 3);
    }
  });

  it("top-face normals are ~radial and wall normals are ~tangential (FrontSide-culling guard)", () => {
    // A voxel wall rendered with three.js's default FrontSide material shows
    // NOTHING if its winding/normal is backwards — Task 3 flagged this as the
    // highest-risk visual-pass concern for Task 4 to inherit. This is the
    // cheap proxy the brief asks for in place of that deferred visual pass:
    // a top face's flat normal should point almost exactly along its own
    // radial (outward) direction (dot ≈ 1), while a wall's flat normal
    // should be almost exactly PERPENDICULAR to radial (dot ≈ 0) — a
    // vertical cliff face's normal has no radial component.
    //
    // cellsPerEdge here is the campaign's REAL voxel granularity (~48), not
    // the other tests' minimal `cellsPerEdge: 2` fixture: the top-face
    // normal is only an APPROXIMATION (the average of a cell's 4 corner unit
    // vectors, not the true tangent-plane normal at the cell's exact
    // center), and that approximation's error grows with the cell's
    // angular size — at `cellsPerEdge: 2` (a whole 90°-wide face split into
    // 2), each cell spans tens of degrees and the approximation error alone
    // exceeds this test's tolerance (~23° off, confirmed while writing this
    // test), which would be a false positive on a fixture no real voxel tile
    // ever uses. At the real ~48-cell granularity a cell spans under 2°,
    // where the same approximation is accurate to a small fraction of a
    // degree — the actual regime this guard needs to check.
    const N = 48;
    const stepTilesFixture = stepTiles();
    const geom = buildVoxelTileGeometry(stepTilesFixture, tile0, 1, 1, () => [200, 100, 40], {
      cellsPerEdge: N,
      bandM: 100,
    });
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    const topVerts = N * N * 6;
    for (let v = 0; v < topVerts; v++) {
      const r = radiusOf(pos, v);
      const radial: [number, number, number] = [pos.getX(v) / r, pos.getY(v) / r, pos.getZ(v) / r];
      const dot = radial[0] * nrm.getX(v) + radial[1] * nrm.getY(v) + radial[2] * nrm.getZ(v);
      expect(dot).toBeGreaterThan(0.99);
    }
    expect(pos.count).toBeGreaterThan(topVerts); // at least one wall exists to check
    for (let v = topVerts; v < pos.count; v++) {
      const r = radiusOf(pos, v);
      const radial: [number, number, number] = [pos.getX(v) / r, pos.getY(v) / r, pos.getZ(v) / r];
      const dot = radial[0] * nrm.getX(v) + radial[1] * nrm.getY(v) + radial[2] * nrm.getZ(v);
      expect(Math.abs(dot)).toBeLessThan(0.1);
    }
  });

  it('buildVoxelTileGeometryIndexed exposes a per-vertex data index and darken multiplier', () => {
    const stepTilesFixture = stepTiles();
    const { geom, index, darken } = buildVoxelTileGeometryIndexed(stepTilesFixture, tile0, 1, 1, () => [200, 100, 40], {
      cellsPerEdge: 2,
      bandM: 100,
    });
    const count = geom.getAttribute('position').count;
    expect(index.length).toBe(count);
    expect(darken.length).toBe(count);
    const topVerts = 4 * 6;
    for (let v = 0; v < topVerts; v++) expect(darken[v]).toBe(1);
    for (let v = topVerts; v < count; v++) expect(darken[v]).toBe(VOXEL_CLIFF_DARKEN);
    // Every one of a cell's 6 top vertices shares that cell's data index.
    for (let c = 0; c < 4; c++) {
      const base = c * 6;
      const i0 = index[base];
      for (let v = base + 1; v < base + 6; v++) expect(index[v]).toBe(i0);
    }
  });
});

/** A region-patch counterpart of `stepTiles`: elevation is defined per NODE
 * (not per equirect pixel) as a clean quadrant step — 5000 m wherever the
 * node's own (lat, lon) has BOTH lat>0 and lon>0, else 0 m — evaluated
 * through the region's own `regionPatchUnits`/`unitLatLon` projection, so it
 * lines up with whatever face/level/ix/iy address is passed rather than
 * assuming face 0's equatorial centering the way `stepTiles` does. `samples:
 * 32` gives a node grid fine enough that `buildVoxelRegionTileGeometry`'s
 * `cellsPerEdge: 2` cell centers (at 25%/75% across the patch) land solidly
 * inside one quadrant each, away from the lat=0/lon=0 seam — mirroring
 * `stepTiles`' own fineness rationale. */
function stepRegion(face: number, level: number, ix: number, iy: number, samples: number): RegionScene {
  const probe = { face, level, ix, iy, samples, elevation_m: [] } as unknown as RegionScene;
  const units = regionPatchUnits(probe);
  const elevation_m = units.map((u) => {
    const { latDeg, lonDeg } = unitLatLon(u);
    return latDeg > 0 && lonDeg > 0 ? 5000 : 0;
  });
  return { face, level, ix, iy, samples, elevation_m } as unknown as RegionScene;
}

describe('buildVoxelRegionTileGeometry', () => {
  const face = 0, level = 0, ix = 0, iy = 0; // the whole equatorial face, matching worldMesh's tile0

  /** Non-indexed flat-shaded geometry: one triangle per 3 position entries. */
  function triangleCount(geom: THREE.BufferGeometry): number {
    return geom.getAttribute('position').count / 3;
  }
  function radiusOf(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): number {
    return Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
  }

  it('emits a top face per cell and a wall ONLY where a cell is higher than a neighbor — same shape as the base builder', () => {
    const region = stepRegion(face, level, ix, iy, 32);
    const geom = buildVoxelRegionTileGeometry(region, 1, 1, () => [1, 1, 1], { cellsPerEdge: 2, bandM: 100 });
    const pos = geom.getAttribute('position');
    // Same fixture shape as `buildVoxelTileGeometry`'s equivalent test: one
    // high cell (lat>0, lon>0), three low — 8 top tris + 2 interior wall
    // quads (the high cell's other two edges are the tile boundary, no wall).
    expect(triangleCount(geom)).toBe(8 + 2 * 2);
    const radii = new Set<number>();
    for (let i = 0; i < 4 * 6; i++) radii.add(Number(radiusOf(pos, i).toFixed(5)));
    expect(radii.size).toBe(2); // one high band, one low band among the 4 tops
  });

  it("colors each cell flat via colorAt(node) — a region node index IS its color index", () => {
    const region = stepRegion(face, level, ix, iy, 32);
    const palette: Record<number, [number, number, number]> = {};
    const colorAt = (i: number): [number, number, number] => {
      palette[i] ??= [(i * 37) % 250, (i * 59) % 250, (i * 83) % 250];
      return palette[i]!;
    };
    const geom = buildVoxelRegionTileGeometry(region, 1, 1, colorAt, { cellsPerEdge: 2, bandM: 100 });
    const col = geom.getAttribute('color');
    for (let c = 0; c < 4; c++) {
      const base = c * 6;
      const r0 = col.getX(base), g0 = col.getY(base), b0 = col.getZ(base);
      for (let v = base + 1; v < base + 6; v++) {
        expect(col.getX(v)).toBeCloseTo(r0, 6);
        expect(col.getY(v)).toBeCloseTo(g0, 6);
        expect(col.getZ(v)).toBeCloseTo(b0, 6);
      }
    }
  });

  it('a wall is darkened relative to its cell\'s top color by VOXEL_CLIFF_DARKEN', () => {
    const region = stepRegion(face, level, ix, iy, 32);
    const geom = buildVoxelRegionTileGeometry(region, 1, 1, () => [200, 100, 40], { cellsPerEdge: 2, bandM: 100 });
    const pos = geom.getAttribute('position');
    const col = geom.getAttribute('color');
    const topVerts = 4 * 6;
    expect(pos.count).toBeGreaterThan(topVerts);
    for (let v = topVerts; v < pos.count; v++) {
      expect(col.getX(v) * 255).toBeCloseTo(200 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getY(v) * 255).toBeCloseTo(100 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getZ(v) * 255).toBeCloseTo(40 * VOXEL_CLIFF_DARKEN, 3);
    }
  });

  it('top-face normals are ~radial and wall normals are ~tangential (FrontSide-culling guard)', () => {
    // Real voxel granularity (~48), not the other tests' minimal
    // `cellsPerEdge: 2` fixture — see the base builder's identical test for
    // why: the top-face normal approximation's error grows with cell
    // angular size, and only shrinks below this test's tolerance at
    // production-realistic granularity. `samples: 64` matches the region
    // producer's real fixed contract (`TILE_QUADS`, per globe.test.ts).
    const N = 48;
    const region = stepRegion(face, level, ix, iy, 64);
    const geom = buildVoxelRegionTileGeometry(region, 1, 1, () => [200, 100, 40], { cellsPerEdge: N, bandM: 100 });
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    const topVerts = N * N * 6;
    for (let v = 0; v < topVerts; v++) {
      const r = radiusOf(pos, v);
      const radial: [number, number, number] = [pos.getX(v) / r, pos.getY(v) / r, pos.getZ(v) / r];
      const dot = radial[0] * nrm.getX(v) + radial[1] * nrm.getY(v) + radial[2] * nrm.getZ(v);
      expect(dot).toBeGreaterThan(0.99);
    }
    expect(pos.count).toBeGreaterThan(topVerts); // at least one wall exists to check
    for (let v = topVerts; v < pos.count; v++) {
      const r = radiusOf(pos, v);
      const radial: [number, number, number] = [pos.getX(v) / r, pos.getY(v) / r, pos.getZ(v) / r];
      const dot = radial[0] * nrm.getX(v) + radial[1] * nrm.getY(v) + radial[2] * nrm.getZ(v);
      expect(Math.abs(dot)).toBeLessThan(0.1);
    }
  });

  it('buildVoxelRegionTileGeometryIndexed exposes a per-vertex data index (a region node id) and darken multiplier', () => {
    const region = stepRegion(face, level, ix, iy, 32);
    const { geom, index, darken } = buildVoxelRegionTileGeometryIndexed(region, 1, 1, () => [200, 100, 40], {
      cellsPerEdge: 2,
      bandM: 100,
    });
    const count = geom.getAttribute('position').count;
    expect(index.length).toBe(count);
    expect(darken.length).toBe(count);
    const nodeCount = (region.samples + 1) * (region.samples + 1);
    for (const i of index) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(nodeCount);
    }
    const topVerts = 4 * 6;
    for (let v = 0; v < topVerts; v++) expect(darken[v]).toBe(1);
    for (let v = topVerts; v < count; v++) expect(darken[v]).toBe(VOXEL_CLIFF_DARKEN);
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

// Analytic normals make BASE tiles agree along shared edges BY CONSTRUCTION
// (both sides derive the normal from the same pure function of (lat, lon) + the
// GLOBAL elevation field). This deleted the old O(all-vertices) `stitchNormals`
// pass for base tiles. It does NOT hold for region patches (see the region test
// at the end of this block): `sampleRegionElevation` clamps its probe to the
// patch's own bounds, so a scoped `stitchNormals` over the mounted region set
// survives for exactly that case.

/** A region patch whose elevation rises linearly west→east across the WHOLE
 * face (via the tile's global column offset `ix*samples + col`), so two
 * horizontally-adjacent patches share a continuous elevation at their border
 * (positions coincide) yet the analytic normal probe — clamped at each patch's
 * own edge — yields a one-sided normal there. The seam the scoped stitch fixes. */
function slopedRegion(face: number, level: number, ix: number, iy: number, samples: number): RegionScene {
  const n = samples + 1;
  const elevation_m: number[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) elevation_m.push((ix * samples + col) * 400);
  }
  return { face, level, ix, iy, samples, elevation_m, moisture: Array(n * n).fill(0.5) } as unknown as RegionScene;
}

describe('analytic normals (buildGridGeometry)', () => {
  it('a flat (zero-elevation) patch has purely radial normals', () => {
    const geom = buildTileGeometry(flatZeroTiles(), { face: 0, level: 2, ix: 1, iy: 1 }, 2, 0, ignoreColor, 0);
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
      const n = new THREE.Vector3().fromBufferAttribute(nrm, i);
      expect(n.length()).toBeCloseTo(1, 5);
      expect(n.dot(p)).toBeGreaterThan(0.99); // radial
    }
  });

  it('a sloped patch tilts the normal off-radial, but never inward', () => {
    const geom = buildTileGeometry(slopedTiles(), { face: 0, level: 0, ix: 0, iy: 0 }, 2, 30, ignoreColor, 0);
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    let sawTilt = false;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
      const n = new THREE.Vector3().fromBufferAttribute(nrm, i);
      expect(n.length()).toBeCloseTo(1, 5);
      const d = n.dot(p);
      expect(d).toBeGreaterThan(0); // always flipped outward, never inward
      if (d < 0.999) sawTilt = true;
    }
    expect(sawTilt).toBe(true);
  });

  it('two same-level neighbouring tiles agree on shared-edge normals without a stitch pass', () => {
    const tiles = bumpyTiles();
    const a = buildTileGeometry(tiles, { face: 0, level: 1, ix: 0, iy: 0 }, 2, 60, ignoreColor);
    const b = buildTileGeometry(tiles, { face: 0, level: 1, ix: 1, iy: 0 }, 2, 60, ignoreColor);
    const n = 65; // TILE_QUADS + 1
    const posA = a.getAttribute('position');
    const nrmA = a.getAttribute('normal');
    const posB = b.getAttribute('position');
    const nrmB = b.getAttribute('normal');
    let checked = 0;
    for (let row = 0; row < n; row++) {
      const ia = row * n + (n - 1); // a's right (max-ix) edge
      const ib = row * n; // b's left (min-ix) edge — the shared border
      // The positions are bit-identical by cubeSphere.ts's dyadic-parameter
      // guarantee; the point of this test is that the NORMALS agree too,
      // with no stitching pass run.
      expect(posA.getX(ia)).toBeCloseTo(posB.getX(ib), 6);
      expect(posA.getY(ia)).toBeCloseTo(posB.getY(ib), 6);
      expect(posA.getZ(ia)).toBeCloseTo(posB.getZ(ib), 6);
      expect(nrmA.getX(ia)).toBeCloseTo(nrmB.getX(ib), 5);
      expect(nrmA.getY(ia)).toBeCloseTo(nrmB.getY(ib), 5);
      expect(nrmA.getZ(ia)).toBeCloseTo(nrmB.getZ(ib), 5);
      checked++;
    }
    expect(checked).toBe(n);
  });

  it('adjacent REGION patches disagree on shared-edge normals (the probe clamps at the patch bound) — a scoped stitchNormals reconciles them', () => {
    // Two horizontally-adjacent level-3 patches; A's east edge shares world
    // position with B's west edge, with continuous elevation across the border.
    // samples MUST be the production count (TILE_QUADS = 64): at a coarse count
    // the region cell (~1.4°) dwarfs the 0.2° probe, which then rounds back to
    // the same node and makes every region normal degenerately radial — a
    // fixture that hides the very seam under test.
    const samples = 64; // TILE_QUADS
    const gA = buildRegionTileGeometry(slopedRegion(0, 3, 0, 0, samples), 2, 60, ignoreColor);
    const gB = buildRegionTileGeometry(slopedRegion(0, 3, 1, 0, samples), 2, 60, ignoreColor);
    const n = samples + 1;
    const posA = gA.getAttribute('position');
    const nrmA = gA.getAttribute('normal');
    const posB = gB.getAttribute('position');
    const nrmB = gB.getAttribute('normal');
    const pairs: [number, number][] = [];
    let sawDisagreement = false;
    for (let row = 0; row < n; row++) {
      const ia = row * n + (n - 1); // A's east (max-col) edge
      const ib = row * n; //           B's west (min-col) edge — the shared border
      // Positions coincide (continuous elevation across the boundary)...
      expect(posA.getX(ia)).toBeCloseTo(posB.getX(ib), 5);
      expect(posA.getY(ia)).toBeCloseTo(posB.getY(ib), 5);
      expect(posA.getZ(ia)).toBeCloseTo(posB.getZ(ib), 5);
      // ...but the analytic normals need not (the clamped probe is one-sided).
      const dx = Math.abs(nrmA.getX(ia) - nrmB.getX(ib));
      const dy = Math.abs(nrmA.getY(ia) - nrmB.getY(ib));
      const dz = Math.abs(nrmA.getZ(ia) - nrmB.getZ(ib));
      if (dx > 1e-3 || dy > 1e-3 || dz > 1e-3) sawDisagreement = true;
      pairs.push([ia, ib]);
    }
    expect(pairs.length).toBe(n); // the patches genuinely share an edge
    expect(sawDisagreement).toBe(true); // ...and analytically disagree (the seam)

    stitchNormals([gA, gB]);
    for (const [ia, ib] of pairs) {
      expect(nrmA.getX(ia)).toBeCloseTo(nrmB.getX(ib), 6);
      expect(nrmA.getY(ia)).toBeCloseTo(nrmB.getY(ib), 6);
      expect(nrmA.getZ(ia)).toBeCloseTo(nrmB.getZ(ib), 6);
    }
  });
});

describe('the natural lens (behavior-preservation regression)', () => {
  it('the natural lens reproduces ocean/biome colors tile for tile, except major water overrides (The Freshwater)', async () => {
    const tiles = await loadSeed42Tiles(64);
    for (let i = 0; i < tiles.width * tiles.height; i++) {
      const expected =
        majorWaterColor(tiles, i) ??
        (tiles.ocean[i]
          ? elevationColor(tiles.elevation_m[i]!, tiles.sea_level_m)
          : biomeColorForName(tiles.biomeLegend[tiles.biome[i]!] ?? ''));
      expect(naturalLens.colorAt(tiles, i, 0)).toEqual(expected);
    }
  });
});

/** A hand-built heightfield fixture: a `samples × samples` cell grid (nodes
 * `(samples+1)²`, all `elevM`) except the LAST cell's own representative node
 * — `(samples-1, samples-1)` in `buildVoxelHeightfieldGeometry`'s own
 * top-left-corner convention (see its doc comment) — which is `highElevM`.
 * That cell sits at the grid's own last row/col, so two of its four edges
 * are the grid boundary (no in-grid neighbor, no wall — the within-region
 * counterpart of `buildVoxelBlocks`'s "no wall at a tile boundary" rule) and
 * the other two border low cells — exactly 2 interior wall quads, the same
 * "one high cell, three low" shape `stepTiles`/`stepRegion` give the sphere
 * voxel builders' own tests. */
function stepHeightfieldRegion(samples: number, elevM: number, highElevM: number): RegionScene {
  const n = samples + 1;
  const elevation_m = new Array(n * n).fill(elevM) as number[];
  elevation_m[(samples - 1) * n + (samples - 1)] = highElevM;
  return { samples, elevation_m } as unknown as RegionScene;
}

/** A flat (uniform-elevation) heightfield fixture — every node the same, so
 * every cell bands to the same height and no wall is ever emitted. */
function flatHeightfieldRegion(samples: number, elevM: number): RegionScene {
  const n = samples + 1;
  const elevation_m = new Array(n * n).fill(elevM) as number[];
  return { samples, elevation_m } as unknown as RegionScene;
}

describe('buildVoxelHeightfieldGeometry', () => {
  /** Non-indexed flat-shaded geometry: one triangle per 3 position entries —
   * the same helper the sphere voxel builders' tests use. */
  function triangleCount(geom: THREE.BufferGeometry): number {
    return geom.getAttribute('position').count / 3;
  }

  /** True if any two of a triangle's 3 vertices sit at the exact same 3D
   * position — a wall between two EQUAL-height cells would be built from a
   * top corner and a bottom corner at the identical height along the
   * identical (x, z), i.e. the identical point, so its two triangles would
   * be degenerate. A correct implementation never emits a wall for an
   * equal-height neighbor, so a degenerate triangle here means the emission
   * rule regressed to `<=` (mirrors the sphere voxel builders' identical
   * helper). */
  function hasWallBetweenEqualCells(geom: THREE.BufferGeometry): boolean {
    const pos = geom.getAttribute('position');
    const same = (i: number, j: number): boolean =>
      Math.abs(pos.getX(i) - pos.getX(j)) < 1e-9 &&
      Math.abs(pos.getY(i) - pos.getY(j)) < 1e-9 &&
      Math.abs(pos.getZ(i) - pos.getZ(j)) < 1e-9;
    for (let t = 0; t < pos.count; t += 3) {
      if (same(t, t + 1) || same(t + 1, t + 2) || same(t, t + 2)) return true;
    }
    return false;
  }

  /** Max absolute value of a position attribute's given component, over
   * every vertex — used to confirm the grid stays within `±extent/2`. */
  function maxAbsComponent(
    pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    axis: 'x' | 'y' | 'z',
  ): number {
    let max = 0;
    for (let i = 0; i < pos.count; i++) {
      const v = axis === 'x' ? pos.getX(i) : axis === 'y' ? pos.getY(i) : pos.getZ(i);
      max = Math.max(max, Math.abs(v));
    }
    return max;
  }

  it('emits a top face per cell and a wall ONLY where a cell is higher than a neighbor', () => {
    const region = stepHeightfieldRegion(2, 0, 5000);
    const geom = buildVoxelHeightfieldGeometry(region, () => [1, 1, 1], { extent: 2, heightScale: 1, bandM: 100 });
    // samples=2 → 2×2 = 4 cells × 2 top tris = 8 top tris; the one high cell
    // sits at the grid's own last row/col (2 of its edges are the grid
    // boundary — no wall there) and borders 2 low cells — 2 interior wall
    // quads (4 tris) — same shape as the sphere builders' step fixture.
    expect(triangleCount(geom)).toBe(8 /* tops */ + 2 * 2 /* two wall quads */);
    // No wall between two equal-height (both-low) cells.
    expect(hasWallBetweenEqualCells(geom)).toBe(false);
  });

  it('lays the grid on the X–Z plane within ±extent/2, height along +Y', () => {
    const region = flatHeightfieldRegion(4, 1000);
    const geom = buildVoxelHeightfieldGeometry(region, () => [1, 1, 1], { extent: 4, heightScale: 1, bandM: 100 });
    const pos = geom.getAttribute('position');
    expect(maxAbsComponent(pos, 'x')).toBeLessThanOrEqual(2 + 1e-6);
    expect(maxAbsComponent(pos, 'z')).toBeLessThanOrEqual(2 + 1e-6);
    // A flat (equal-elevation, so equal-banded-height) region emits no walls
    // at all — every top vertex sits at the SAME banded Y.
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(Number(pos.getY(i).toFixed(6)));
    expect(ys.size).toBe(1);
    // `ys.size === 1` alone doesn't prove no walls: a `<`→`<=` regression on
    // the emission guard would emit degenerate equal-height wall quads whose
    // top and bottom Y are identical, which would still pass that check. Nail
    // it down directly — samples=4 → 16 cells × 2 top tris each, no walls —
    // and confirm no wall triangle (degenerate at an equal-height boundary)
    // exists at all.
    expect(triangleCount(geom)).toBe(4 * 4 * 2 /* top faces only, no walls */);
    expect(hasWallBetweenEqualCells(geom)).toBe(false);
  });

  it("colors each cell flat via colorAt(node) — a region node index IS its color index", () => {
    const region = stepHeightfieldRegion(2, 0, 5000);
    const palette: Record<number, [number, number, number]> = {};
    const colorAt = (i: number): [number, number, number] => {
      palette[i] ??= [(i * 37) % 250, (i * 59) % 250, (i * 83) % 250];
      return palette[i]!;
    };
    const geom = buildVoxelHeightfieldGeometry(region, colorAt, { extent: 2, heightScale: 1, bandM: 100 });
    const col = geom.getAttribute('color');
    // Pass 1 emits every cell's 6 top vertices contiguously, in row-major
    // (row*samples+col) order, before any wall — cell `c`'s top face is
    // exactly vertices [c*6, c*6+6), each sharing one flat color.
    for (let c = 0; c < 4; c++) {
      const base = c * 6;
      const r0 = col.getX(base), g0 = col.getY(base), b0 = col.getZ(base);
      for (let v = base + 1; v < base + 6; v++) {
        expect(col.getX(v)).toBeCloseTo(r0, 6);
        expect(col.getY(v)).toBeCloseTo(g0, 6);
        expect(col.getZ(v)).toBeCloseTo(b0, 6);
      }
    }
  });

  it("a wall is darkened relative to its cell's top color by VOXEL_CLIFF_DARKEN", () => {
    const region = stepHeightfieldRegion(2, 0, 5000);
    const geom = buildVoxelHeightfieldGeometry(region, () => [200, 100, 40], { extent: 2, heightScale: 1, bandM: 100 });
    const pos = geom.getAttribute('position');
    const col = geom.getAttribute('color');
    const topVerts = 4 * 6;
    expect(pos.count).toBeGreaterThan(topVerts);
    for (let v = topVerts; v < pos.count; v++) {
      expect(col.getX(v) * 255).toBeCloseTo(200 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getY(v) * 255).toBeCloseTo(100 * VOXEL_CLIFF_DARKEN, 3);
      expect(col.getZ(v) * 255).toBeCloseTo(40 * VOXEL_CLIFF_DARKEN, 3);
    }
  });

  it('top-face normals point straight up (+Y); wall normals are horizontal', () => {
    const region = stepHeightfieldRegion(2, 0, 5000);
    const geom = buildVoxelHeightfieldGeometry(region, () => [200, 100, 40], { extent: 2, heightScale: 1, bandM: 100 });
    const nrm = geom.getAttribute('normal');
    const topVerts = 4 * 6;
    for (let v = 0; v < topVerts; v++) {
      expect(nrm.getX(v)).toBeCloseTo(0, 5);
      expect(nrm.getY(v)).toBeCloseTo(1, 5);
      expect(nrm.getZ(v)).toBeCloseTo(0, 5);
    }
    expect(nrm.count).toBeGreaterThan(topVerts); // at least one wall exists to check
    for (let v = topVerts; v < nrm.count; v++) {
      expect(Math.abs(nrm.getY(v))).toBeLessThan(1e-5); // a vertical wall's normal is purely horizontal
    }
  });
});
