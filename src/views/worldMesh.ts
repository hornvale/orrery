/** The shared face-mesh builder: turns `scene/tiles/v1` into a colored,
 * optionally-displaced cube-sphere face — the geometry both `./globe.ts`
 * (real relief, schematic globe radius) and `./system.ts` (smooth, AU-scale
 * world sphere) build their faces from. One mismatch here shows up as two
 * views disagreeing about the same world.
 */
import * as THREE from 'three';
import type { RegionScene, TilesScene } from '../sim/scene';
import type { RGB } from './lens';
import { TILE_QUADS, faceUnit, tileGrid, unitFromLatLon, unitLatLon, type TileId } from './cubeSphere';
import { nearestRegionNodeIndex, regionPatchUnits, sampleRegionElevationBilinear } from './regionPatch';

/** Reference body radius (Earth's, meters) used only to turn raw elevation
 * meters into a *fraction* of a rendered radius before exaggerating — not a
 * claim that the rendered world has this radius. */
export const REFERENCE_RADIUS_M = 6.371e6;

/** The tile-grid array fields `sampleTile` can index into — every
 * `TilesScene` field that is a flat, row-major per-tile layer. */
type TileArrayKey = {
  [K in keyof TilesScene]: TilesScene[K] extends readonly unknown[] ? K : never;
}[keyof TilesScene];

/** Row-major index into any `scene/tiles/v1` per-tile layer at `(lat, lon)`:
 * row 0 is lat +90..0 downward, col 0 is lon −180, values are pixel centers
 * (`windows/scene/src/lib.rs:68-71`, binding convention — fix a mismatch
 * here, never there). Longitude wraps at the ±180 seam; latitude clamps at
 * the poles. Shared by `sampleTile` and any caller that needs the index
 * itself (e.g. `./ice.ts` and `./globe.ts` precomputing per-vertex indices
 * once instead of resampling per field). */
export function tileIndex(tiles: TilesScene, lat: number, lon: number): number {
  const rowSpan = 180 / tiles.height;
  const colSpan = 360 / tiles.width;
  const row = Math.min(tiles.height - 1, Math.max(0, Math.floor((90 - lat) / rowSpan)));
  const rawCol = Math.floor((lon + 180) / colSpan);
  const col = ((rawCol % tiles.width) + tiles.width) % tiles.width;
  return row * tiles.width + col;
}

/** Bilinearly-interpolated elevation (metres) at `(lat, lon)` over the same
 * row-major pixel-center lattice `tileIndex` addresses. The geometry samples
 * elevation CONTINUOUSLY rather than snapping to the nearest cell, so relief —
 * and the analytic normals taken from its gradient — are smooth instead of
 * stepping at every data-cell boundary. That step was catastrophic under 60×
 * relief: a one-cell elevation jump became a near-vertical wall over the 0.2°
 * normal probe, tilting the normal to grazing (black on the lit side, bright on
 * the dark side). Longitude wraps at the ±180 seam; latitude clamps at the
 * poles — matching `tileIndex`. Elevation only: discrete layers (biome, ocean)
 * are never interpolated (their `colorAt` still samples the nearest cell). */
export function sampleElevationBilinear(tiles: TilesScene, lat: number, lon: number): number {
  const rowSpan = 180 / tiles.height;
  const colSpan = 360 / tiles.width;
  // Pixel CENTERS: cell (r,c) is centered half a span in, so shift by 0.5.
  const fy = (90 - lat) / rowSpan - 0.5;
  const fx = (lon + 180) / colSpan - 0.5;
  const r0 = Math.floor(fy);
  const c0 = Math.floor(fx);
  const ty = fy - r0;
  const tx = fx - c0;
  const elev = tiles.elevation_m as unknown as ArrayLike<number>;
  const rowAt = (r: number): number => Math.min(tiles.height - 1, Math.max(0, r));
  const colAt = (c: number): number => ((c % tiles.width) + tiles.width) % tiles.width;
  const at = (r: number, c: number): number => elev[rowAt(r) * tiles.width + colAt(c)]!;
  const top = at(r0, c0) * (1 - tx) + at(r0, c0 + 1) * tx;
  const bot = at(r0 + 1, c0) * (1 - tx) + at(r0 + 1, c0 + 1) * tx;
  return top * (1 - ty) + bot * ty;
}

/** Sample a per-tile layer at `(lat, lon)` through the row-major equirect
 * lattice `scene/tiles/v1` defines — see `tileIndex` for the addressing. */
export function sampleTile<K extends TileArrayKey>(
  tiles: TilesScene,
  lat: number,
  lon: number,
  field: K,
): TilesScene[K] extends readonly (infer E)[] ? E : never {
  const layer = tiles[field] as unknown as ArrayLike<unknown>;
  return layer[tileIndex(tiles, lat, lon)] as never;
}

/** Snap an elevation (metres) down to the floor of its `bandM`-wide band —
 * the quantization behind the Terraced style's stepped, "rice-terrace"
 * contour. Floor-snapped (not rounded), so a band covers
 * `[k*bandM, (k+1)*bandM)` for every integer `k`, including negative `k`:
 * below sea level steps DOWN too (`quantizeBands(-1, 200)` is `-200`, not
 * `0`) — one consistent staircase direction rather than a floor that
 * reverses at zero. Pure and side-effect-free so it composes into any
 * `radiusAtLatLon` closure (below) without its own test fixture. */
export function quantizeBands(elevationM: number, bandM: number): number {
  return Math.floor(elevationM / bandM) * bandM;
}

/** Build one cube-sphere *tile*'s displaced, vertex-colored geometry, at
 * whatever `level`/`ix`/`iy` the `TileId` names (a level-0 tile is the whole
 * face; deeper tiles are the adaptive-LOD quadtree's finer squares). Each
 * tile is a uniform `TILE_QUADS`×`TILE_QUADS` grid, so a deeper level samples
 * the same data on a finer lattice — smoother relief where the camera is
 * close. `radius` is the rendered sphere's undisplaced radius (world units);
 * `reliefScale` is the exaggeration multiple applied to elevation before it
 * displaces the surface — 0 gives a smooth sphere. `bandM`, if given, quantizes
 * the sampled elevation through `quantizeBands` before it displaces anything
 * (the Terraced style's stepped contour); omitted (the default), the
 * elevation displaces continuously — today's Smooth path, byte-identical to
 * before this parameter existed. */
export function buildTileGeometry(
  tiles: TilesScene,
  tile: TileId,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  skirtDepth = 0,
  bandM?: number,
): THREE.BufferGeometry {
  const grid = tileGrid(tile);
  const n = TILE_QUADS + 1;
  // A pure function of (lat, lon) — the SAME path a vertex's own displaced
  // position uses — so the analytic normal probe (which evaluates this at
  // lat/lon-offset neighbours, not just grid vertices) agrees bit-for-bit
  // with whatever any OTHER tile computes at that same (lat, lon). Banding
  // (when `bandM` is set) happens INSIDE this closure, before the elevation
  // displaces the surface, so the probe's neighbour samples see the same
  // stepped field the surface itself does — normals step at band edges
  // (flat within a band, a crease at the riser), which is the terraced look.
  const radiusAtLatLon = (lat: number, lon: number): number => {
    const elev = sampleElevationBilinear(tiles, lat, lon);
    const banded = bandM === undefined ? elev : quantizeBands(elev, bandM);
    return radius * (1 + (reliefScale * banded) / REFERENCE_RADIUS_M);
  };
  return buildGridGeometry(
    n,
    (i) => [grid.units[3 * i]!, grid.units[3 * i + 1]!, grid.units[3 * i + 2]!],
    (i) => radiusAtLatLon(grid.lats[i]!, grid.lons[i]!),
    (i) => colorAt(tileIndex(tiles, grid.lats[i]!, grid.lons[i]!)),
    skirtDepth,
    (i) => [grid.lats[i]!, grid.lons[i]!],
    radiusAtLatLon,
  );
}

/** Build a tile from a `scene/tiles-region/v1` patch: the producer's true
 * higher-res terrain, re-sampled at the tile's own grid rather than
 * interpolated from the coarse tiles export. Same cube-sphere projection
 * (`regionPatchUnits`) so it registers on the globe exactly where the
 * interpolated tile it replaces did. `colorAt(i)` is the lens applied to the
 * region's node `i` (the region carries the same per-node fields the lens
 * reads). `bandM`, if given, quantizes elevation through `quantizeBands`
 * before displacement (the Terraced style); omitted, the continuous path
 * (Smooth) is unchanged. */
export function buildRegionTileGeometry(
  region: RegionScene,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  skirtDepth = 0,
  bandM?: number,
): THREE.BufferGeometry {
  const units = regionPatchUnits(region);
  const n = region.samples + 1;
  const applyBand = (elev: number): number => (bandM === undefined ? elev : quantizeBands(elev, bandM));
  // Pure function of (lat, lon) via the region's own field (see
  // `sampleRegionElevation`) — the counterpart of `buildTileGeometry`'s
  // `radiusAtLatLon`, used by the analytic normal probe. Bands (via
  // `applyBand`) the same way the surface's own `radiusAt` below does, so
  // the probe reads the identical stepped field.
  const radiusAtLatLon = (lat: number, lon: number): number =>
    radius * (1 + (reliefScale * applyBand(sampleRegionElevationBilinear(region, lat, lon))) / REFERENCE_RADIUS_M);
  return buildGridGeometry(
    n,
    (i) => units[i]!,
    (i) => radius * (1 + (reliefScale * applyBand(region.elevation_m[i]!)) / REFERENCE_RADIUS_M),
    (i) => colorAt(i), // a region node's index IS the colour index
    skirtDepth,
    (i) => {
      const { latDeg, lonDeg } = unitLatLon(units[i]!);
      return [latDeg, lonDeg];
    },
    radiusAtLatLon,
  );
}

/** Darkening multiplier applied to a wall (cliff) face's color relative to
 * its cell's top-face color — a fixed, flat multiplier (not a lighting
 * calculation), so a cliff reads as a distinct vertical face at a glance
 * regardless of the scene's actual light direction. ~0.75: dark enough to
 * read as a riser, light enough that the cell's own hue stays recognizable. */
export const VOXEL_CLIFF_DARKEN = 0.75;

/** Per-vertex bookkeeping a voxel builder produces alongside its geometry —
 * what the Voxel style's living-lens repaint needs to recolor an
 * already-built block mesh without a full rebuild (Task 4). `index[v]` is
 * the data-source index `colorAt` was called with to bake vertex `v`'s
 * color (a cell's top face AND all its wall vertices share one `index` —
 * the cell's own, since a voxel cell is flat-colored). `darken[v]` is the
 * flat multiplier repaint applies to the freshly recomputed lens color
 * (1 for a top vertex, `VOXEL_CLIFF_DARKEN` for a wall) — mirroring the
 * darkening this same builder bakes into a wall's color at build time, so a
 * repainted wall stays exactly as dark relative to its cell as the
 * originally built one. */
export interface VoxelVertexIndex {
  /** Data-source index per vertex — length equals the geometry's vertex
   * count (`position.count`). */
  index: Int32Array;
  /** Flat color multiplier per vertex — same length as `index`. */
  darken: Float32Array;
}

/** A voxel builder's full result: the renderable geometry plus the
 * `VoxelVertexIndex` bookkeeping `globe.ts`'s repaint needs. The plain
 * `buildVoxelTileGeometry`/`buildVoxelRegionTileGeometry` (below) return
 * just `.geom` — their pre-existing signature, unchanged, for callers (this
 * file's own tests) that only want a mesh; the `...Indexed` variants return
 * the full result. */
export interface VoxelBuildResult extends VoxelVertexIndex {
  /** The non-indexed, flat-shaded `position`/`normal`/`color` geometry. */
  geom: THREE.BufferGeometry;
}

/** Build one cube-face tile's geometry (base OR region — see below) as a
 * `cellsPerEdge × cellsPerEdge` grid of extruded, flat-topped blocks — the
 * Voxel style's shared keystone build. Each cell samples its own BANDED
 * elevation (`quantizeBands`, reusing the Terraced style's banding) and
 * renders as a flat-shaded, flat-colored top face at that band's radius;
 * wherever an edge-neighbor's banded radius is LOWER, a vertical wall (the
 * "cliff") drops from this cell's radius down to the neighbor's, darkened by
 * `VOXEL_CLIFF_DARKEN`. That wall is what makes this read as blocks stacked
 * on the terrain rather than merely a banded (but still smooth) surface —
 * a voxel build with no walls is a failed voxel.
 *
 * Generalized over the cube-face address (`face`/`level`/`ix`/`iy`) and the
 * elevation/index sampling (`sampleElevation`/`indexAt`) so ONE algorithm
 * serves both the tiles-export base tile (`buildVoxelTileGeometryIndexed`,
 * sampling `sampleElevationBilinear`/`tileIndex`) and a `RegionScene` patch
 * (`buildVoxelRegionTileGeometryIndexed`, sampling
 * `sampleRegionElevationBilinear`/`nearestRegionNodeIndex`) — the wall/top
 * emission logic (the actual voxel algorithm) is written exactly once.
 *
 * Algorithm:
 * 1. Sub-sample the face address into `cellsPerEdge`² cells. Each cell's
 *    center (lat, lon) comes from the SAME cube-sphere mapping `tileGrid`
 *    uses (`faceUnit`/`unitLatLon`), just parameterized by `cellsPerEdge`
 *    instead of `TILE_QUADS` — so corners land exactly on the sphere, not on
 *    an interpolation of the `TILE_QUADS` lattice. `cellsPerEdge` is
 *    independent of and typically far coarser than that lattice (voxels
 *    read chunky by design — 48-96 is a reasonable range) and, for a region
 *    patch, independent of the patch's own `samples` node count too (a
 *    region always arrives at a fixed `samples` — see `globe.ts` — decoupled
 *    from the voxel granularity).
 * 2. Top face: the cell's four corners at its own banded radius, two
 *    triangles, one flat per-cell normal (the corner average, i.e. the
 *    outward direction at the cell's own center) and one flat per-cell
 *    color (`colorAt`, nearest — never blended).
 * 3. Walls: for each of the 4 edge-neighbors, if the neighbor's banded
 *    radius is strictly lower, emit a vertical quad along the shared edge
 *    from this radius down to the neighbor's, one flat (outward-facing)
 *    normal, darkened color. A cell at this tile's own edge whose neighbor
 *    would fall outside the tile uses this tile's OWN edge-cell radius as
 *    that neighbor's value — i.e. no wall is built at a tile boundary. A
 *    real adjacent tile's true edge cell can differ by up to one band, so
 *    that boundary can show a seam at most one `bandM` tall; closing it
 *    needs the neighbor tile's own data.
 * 4. No skirt: the walls seal the silhouette on their own.
 *
 * Built in two passes over the `cellsPerEdge`² cells — every cell's top
 * face first (`cells × 6` vertices, contiguous per cell in row-major
 * `row*cellsPerEdge+col` order), then every cell's walls — so the vertex
 * layout stays simple and predictable (and cheap to test) rather than
 * interleaving a cell's top with its own walls. Non-indexed (flat shading
 * needs unshared per-triangle vertices) with `position`/`normal`/`color`
 * attributes (plus the parallel `index`/`darken` bookkeeping above); typed
 * arrays are sized up front from the algorithm's own worst case
 * (`cells × (6 top + 4 edges × 6 wall)` vertices) and trimmed with
 * `subarray` to the vertex count actually used — no push()-driven
 * reallocation. */
function buildVoxelBlocks(
  face: number,
  level: number,
  ix: number,
  iy: number,
  N: number,
  radius: number,
  reliefScale: number,
  bandM: number,
  sampleElevation: (latDeg: number, lonDeg: number) => number,
  indexAt: (latDeg: number, lonDeg: number) => number,
  colorAt: (i: number) => RGB,
): VoxelBuildResult {
  const scale = 1 << level;

  // Face params for the (N+1)-wide corner lattice, denominated in N
  // (cellsPerEdge) rather than TILE_QUADS — otherwise the SAME dyadic
  // mapping `tileGrid`'s internal `param` helper uses.
  const aAt = (col: number): number => -1 + (2 * (ix + col / N)) / scale;
  const bAt = (row: number): number => -1 + (2 * (iy + row / N)) / scale;

  // Corner unit vectors, computed once: (N+1)×(N+1), row-major over row (b)
  // then col (a) — matching `tileGrid`'s own row/col convention.
  const cn = N + 1;
  const cornerX = new Float64Array(cn * cn);
  const cornerY = new Float64Array(cn * cn);
  const cornerZ = new Float64Array(cn * cn);
  for (let row = 0; row <= N; row++) {
    const b = bAt(row);
    for (let col = 0; col <= N; col++) {
      const [ux, uy, uz] = faceUnit(face, aAt(col), b);
      const k = row * cn + col;
      cornerX[k] = ux;
      cornerY[k] = uy;
      cornerZ[k] = uz;
    }
  }
  const corner = (row: number, col: number): [number, number, number] => {
    const k = row * cn + col;
    return [cornerX[k]!, cornerY[k]!, cornerZ[k]!];
  };

  // Per-cell banded radius, color index, color, and center unit vector,
  // computed once (N×N) — the wall pass below reads a neighbor's radius
  // without resampling elevation, and reuses the same cell's own center.
  const cellRadius = new Float64Array(N * N);
  const cellCenter: [number, number, number][] = new Array(N * N);
  const cellDataIdx = new Int32Array(N * N);
  const cellColor: RGB[] = new Array(N * N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const u = faceUnit(face, aAt(col + 0.5), bAt(row + 0.5));
      const { latDeg, lonDeg } = unitLatLon(u);
      const elev = sampleElevation(latDeg, lonDeg);
      const banded = quantizeBands(elev, bandM);
      cellRadius[idx] = radius * (1 + (reliefScale * banded) / REFERENCE_RADIUS_M);
      cellCenter[idx] = u;
      const dataIdx = indexAt(latDeg, lonDeg);
      cellDataIdx[idx] = dataIdx;
      cellColor[idx] = colorAt(dataIdx);
    }
  }
  // A cell just outside [0, N) (the tile's own boundary) has no in-tile
  // neighbor — fall back to `ownIdx`'s own radius (see the doc comment: a
  // deliberate, bounded seam, not a bug).
  const neighborRadius = (ownIdx: number, row: number, col: number): number =>
    row < 0 || row >= N || col < 0 || col >= N ? cellRadius[ownIdx]! : cellRadius[row * N + col]!;

  const maxVerts = N * N * (6 + 4 * 6);
  const pos = new Float32Array(maxVerts * 3);
  const nrm = new Float32Array(maxVerts * 3);
  const colArr = new Float32Array(maxVerts * 3);
  const vertIndex = new Int32Array(maxVerts);
  const vertDarken = new Float32Array(maxVerts);
  let vi = 0;

  const pushVertex = (
    p: readonly [number, number, number],
    n: readonly [number, number, number],
    rgb: RGB,
    dataIdx: number,
    darken: number,
  ): void => {
    const o = vi * 3;
    pos[o] = p[0];
    pos[o + 1] = p[1];
    pos[o + 2] = p[2];
    nrm[o] = n[0];
    nrm[o + 1] = n[1];
    nrm[o + 2] = n[2];
    colArr[o] = rgb[0] / 255;
    colArr[o + 1] = rgb[1] / 255;
    colArr[o + 2] = rgb[2] / 255;
    vertIndex[vi] = dataIdx;
    vertDarken[vi] = darken;
    vi++;
  };

  // Pass 1: every cell's top face, row-major — keeps a cell's 6 top
  // vertices at a fixed, predictable offset (`(row*N+col)*6`).
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const r = cellRadius[idx]!;
      const rgb = cellColor[idx]!;
      const dataIdx = cellDataIdx[idx]!;
      const u00 = corner(row, col);
      const u10 = corner(row, col + 1);
      const u01 = corner(row + 1, col);
      const u11 = corner(row + 1, col + 1);
      const p00: [number, number, number] = [u00[0] * r, u00[1] * r, u00[2] * r];
      const p10: [number, number, number] = [u10[0] * r, u10[1] * r, u10[2] * r];
      const p01: [number, number, number] = [u01[0] * r, u01[1] * r, u01[2] * r];
      const p11: [number, number, number] = [u11[0] * r, u11[1] * r, u11[2] * r];
      // Flat per-cell normal: the outward direction at the cell's own
      // center (the average of its 4 corner unit vectors, renormalized) —
      // a flat-topped block's top face is perpendicular to ITS OWN local
      // "up", not a cross-tile-smoothed normal.
      let nx = u00[0] + u10[0] + u01[0] + u11[0];
      let ny = u00[1] + u10[1] + u01[1] + u11[1];
      let nz = u00[2] + u10[2] + u01[2] + u11[2];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const topNormal: [number, number, number] = [nx, ny, nz];
      // Same CCW-in-(a,b) winding as `buildGridGeometry` — outward on every
      // face without a per-face special case.
      pushVertex(p00, topNormal, rgb, dataIdx, 1);
      pushVertex(p10, topNormal, rgb, dataIdx, 1);
      pushVertex(p11, topNormal, rgb, dataIdx, 1);
      pushVertex(p00, topNormal, rgb, dataIdx, 1);
      pushVertex(p11, topNormal, rgb, dataIdx, 1);
      pushVertex(p01, topNormal, rgb, dataIdx, 1);
    }
  }

  // A vertical quad from this cell's own radius (`rTop`) down to a lower
  // neighbor's (`rBot`), along the shared edge's two corner unit vectors
  // (`cA`, `cB`). One flat normal for both triangles (the wall reads as one
  // cliff face, matching the top face's per-cell-flat treatment): the
  // actual quad geometry's own cross-product normal, flipped (both
  // triangles together, via `pushTri`'s vertex swap) if needed to agree in
  // sign with an approximate outward reference — the direction from this
  // cell's own center toward the shared edge's midpoint — so the wall
  // faces away from its cell regardless of which of the 4 edges it is.
  const emitWall = (
    cA: readonly [number, number, number],
    cB: readonly [number, number, number],
    rTop: number,
    rBot: number,
    center: readonly [number, number, number],
    rgb: RGB,
    dataIdx: number,
  ): void => {
    const topA: [number, number, number] = [cA[0] * rTop, cA[1] * rTop, cA[2] * rTop];
    const topB: [number, number, number] = [cB[0] * rTop, cB[1] * rTop, cB[2] * rTop];
    const botA: [number, number, number] = [cA[0] * rBot, cA[1] * rBot, cA[2] * rBot];
    const botB: [number, number, number] = [cB[0] * rBot, cB[1] * rBot, cB[2] * rBot];
    const e1x = topB[0] - topA[0], e1y = topB[1] - topA[1], e1z = topB[2] - topA[2];
    const e2x = botA[0] - topA[0], e2y = botA[1] - topA[1], e2z = botA[2] - topA[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const midLen = Math.hypot(cA[0] + cB[0], cA[1] + cB[1], cA[2] + cB[2]) || 1;
    const outX = (cA[0] + cB[0]) / midLen - center[0];
    const outY = (cA[1] + cB[1]) / midLen - center[1];
    const outZ = (cA[2] + cB[2]) / midLen - center[2];
    const flip = nx * outX + ny * outY + nz * outZ < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const wallNormal: [number, number, number] = [nx, ny, nz];
    const wallColor: RGB = [rgb[0] * VOXEL_CLIFF_DARKEN, rgb[1] * VOXEL_CLIFF_DARKEN, rgb[2] * VOXEL_CLIFF_DARKEN];
    const pushTri = (
      v0: readonly [number, number, number],
      v1: readonly [number, number, number],
      v2: readonly [number, number, number],
    ): void => {
      // Swapping the last two vertices flips the triangle's winding (and so
      // its front-facing side) without recomputing the normal.
      if (!flip) {
        pushVertex(v0, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
        pushVertex(v1, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
        pushVertex(v2, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
      } else {
        pushVertex(v0, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
        pushVertex(v2, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
        pushVertex(v1, wallNormal, wallColor, dataIdx, VOXEL_CLIFF_DARKEN);
      }
    };
    pushTri(topA, topB, botA);
    pushTri(topB, botB, botA);
  };

  // Pass 2: every cell's walls (0-4 quads each, only where a lower
  // neighbor exists).
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const idx = row * N + col;
      const rOwn = cellRadius[idx]!;
      const rgb = cellColor[idx]!;
      const center = cellCenter[idx]!;
      const dataIdx = cellDataIdx[idx]!;
      const u00 = corner(row, col);
      const u10 = corner(row, col + 1);
      const u01 = corner(row + 1, col);
      const u11 = corner(row + 1, col + 1);
      const rUp = neighborRadius(idx, row - 1, col);
      if (rUp < rOwn) emitWall(u00, u10, rOwn, rUp, center, rgb, dataIdx);
      const rDown = neighborRadius(idx, row + 1, col);
      if (rDown < rOwn) emitWall(u01, u11, rOwn, rDown, center, rgb, dataIdx);
      const rLeft = neighborRadius(idx, row, col - 1);
      if (rLeft < rOwn) emitWall(u00, u01, rOwn, rLeft, center, rgb, dataIdx);
      const rRight = neighborRadius(idx, row, col + 1);
      if (rRight < rOwn) emitWall(u10, u11, rOwn, rRight, center, rgb, dataIdx);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, vi * 3), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, vi * 3), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colArr.subarray(0, vi * 3), 3));
  return { geom, index: vertIndex.subarray(0, vi), darken: vertDarken.subarray(0, vi) };
}

/** Build one cube-sphere tile's geometry (from `scene/tiles/v1`) as extruded,
 * flat-topped blocks — the Voxel style's base-tile geometry, and the
 * campaign's keystone build. See `buildVoxelBlocks` for the full algorithm;
 * this wrapper supplies the tiles-export sampling
 * (`sampleElevationBilinear`/`tileIndex`). Returns just the geometry — for
 * the per-vertex index/darken bookkeeping a living-lens repaint needs, see
 * `buildVoxelTileGeometryIndexed`. */
export function buildVoxelTileGeometry(
  tiles: TilesScene,
  tile: TileId,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  opts: { cellsPerEdge: number; bandM: number },
): THREE.BufferGeometry {
  return buildVoxelTileGeometryIndexed(tiles, tile, radius, reliefScale, colorAt, opts).geom;
}

/** `buildVoxelTileGeometry`'s full result — geometry plus the per-vertex
 * `index`/`darken` bookkeeping `globe.ts`'s repaint path reads. */
export function buildVoxelTileGeometryIndexed(
  tiles: TilesScene,
  tile: TileId,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  opts: { cellsPerEdge: number; bandM: number },
): VoxelBuildResult {
  return buildVoxelBlocks(
    tile.face,
    tile.level,
    tile.ix,
    tile.iy,
    opts.cellsPerEdge,
    radius,
    reliefScale,
    opts.bandM,
    (lat, lon) => sampleElevationBilinear(tiles, lat, lon),
    (lat, lon) => tileIndex(tiles, lat, lon),
    colorAt,
  );
}

/** Build a `scene/tiles-region/v1` patch's geometry as extruded, flat-topped
 * blocks — the Voxel style's region-tile geometry (Task 4), the counterpart
 * of `buildVoxelTileGeometry` for the producer's true higher-res terrain.
 * Sources elevation from `region.elevation_m` via `sampleRegionElevationBilinear`
 * (continuous, exactly as `buildRegionTileGeometry` samples for its own
 * analytic-normal probe) and each cell's color index from
 * `nearestRegionNodeIndex` (a region node index IS its color index, per
 * `buildRegionTileGeometry`'s convention) — deliberately re-sampled at the
 * voxel's own `cellsPerEdge` granularity rather than reusing the region's
 * `samples` node grid directly, since a region patch arrives at a fixed
 * `samples` (the producer's own contract — see `globe.ts`) independent of
 * the voxel style's granularity constant. See `buildVoxelBlocks` for the
 * shared algorithm (top faces, cliff walls, banding) — not re-implemented
 * here. Returns just the geometry; see `buildVoxelRegionTileGeometryIndexed`
 * for the repaint bookkeeping. */
export function buildVoxelRegionTileGeometry(
  region: RegionScene,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  opts: { cellsPerEdge: number; bandM: number },
): THREE.BufferGeometry {
  return buildVoxelRegionTileGeometryIndexed(region, radius, reliefScale, colorAt, opts).geom;
}

/** `buildVoxelRegionTileGeometry`'s full result — geometry plus the
 * per-vertex `index`/`darken` bookkeeping `globe.ts`'s repaint path reads. */
export function buildVoxelRegionTileGeometryIndexed(
  region: RegionScene,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  opts: { cellsPerEdge: number; bandM: number },
): VoxelBuildResult {
  return buildVoxelBlocks(
    region.face,
    region.level,
    region.ix,
    region.iy,
    opts.cellsPerEdge,
    radius,
    reliefScale,
    opts.bandM,
    (lat, lon) => sampleRegionElevationBilinear(region, lat, lon),
    (lat, lon) => nearestRegionNodeIndex(region, lat, lon),
    colorAt,
  );
}

/** Fixed lat/lon step (degrees) for the analytic-normal gradient probe —
 * see `analyticNormal`. A global constant, not derived from any tile's own
 * grid spacing: two tiles at different LOD levels never share a coincident
 * vertex (skirts fill that crack instead), but same-level neighbours and
 * region patches DO, and only a step defined purely in (lat, lon) — the one
 * coordinate every tile/region agrees on regardless of its own face/level
 * orientation — guarantees both sides probe the identical two neighbour
 * points. The value trades off against the data's own grid: too small and
 * it can stay within a single elevation-grid cell (a locally flat, radial
 * normal with a sharp crease right at the cell boundary — not wrong, just
 * blocky); too large and it blurs fine relief into its neighbours. 0.2°
 * (~22 km at the equator) is order-of-magnitude the production tiles-export
 * data grid (512-wide, ~0.7°/cell) and comparable to a region patch's own
 * node spacing at typical CDLOD depth; retune here if the controller's
 * visual pass finds seams or over-smoothing against the shipped data. */
const NORMAL_PROBE_DELTA_DEG = 0.2;

/** Analytic per-vertex normal at (lat, lon): displace `unit(lat,lon)` and
 * two lat/lon-offset neighbours through the SAME `radiusAtLatLon` the
 * surface itself uses, then take the outward-facing cross product of the
 * two tangents. A pure function of (lat, lon) + the field, so any two
 * callers evaluating the same (lat, lon) — e.g. two same-level tiles
 * sharing a border, or a region patch and the global field it refines —
 * get the bit-identical normal. That's what lets `buildGridGeometry` drop
 * THREE's face-averaged `computeVertexNormals()` (one-sided at tile edges)
 * without a post-hoc cross-tile stitch. */
function analyticNormal(
  lat: number,
  lon: number,
  radiusAtLatLon: (lat: number, lon: number) => number,
): [number, number, number] {
  const displaced = (la: number, lo: number): [number, number, number] => {
    const [ux, uy, uz] = unitFromLatLon(la, lo);
    const r = radiusAtLatLon(la, lo);
    return [ux * r, uy * r, uz * r];
  };
  const p = displaced(lat, lon);
  const pLon = displaced(lat, lon + NORMAL_PROBE_DELTA_DEG);
  const pLat = displaced(lat + NORMAL_PROBE_DELTA_DEG, lon);
  const tLon: [number, number, number] = [pLon[0] - p[0], pLon[1] - p[1], pLon[2] - p[2]];
  const tLat: [number, number, number] = [pLat[0] - p[0], pLat[1] - p[1], pLat[2] - p[2]];
  let nx = tLon[1] * tLat[2] - tLon[2] * tLat[1];
  let ny = tLon[2] * tLat[0] - tLon[0] * tLat[2];
  let nz = tLon[0] * tLat[1] - tLon[1] * tLat[0];
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const [ux, uy, uz] = unitFromLatLon(lat, lon);
  if (nx * ux + ny * uy + nz * uz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return [nx, ny, nz];
}

/** Shared cube-sphere grid → geometry: an (n×n) lattice of unit vectors
 * (`unitAt`) displaced to `radiusAt`, vertex-coloured by `colorOf` (0-255),
 * plus an optional crack-filling skirt. Both the tiles-export builder and the
 * region-patch builder are thin wrappers over this. Normals are analytic
 * (`analyticNormal`), computed from `latLonAt`/`radiusAtLatLon` rather than
 * THREE's face-averaged `computeVertexNormals()`, so shared edge vertices
 * between adjacent tiles get the same normal by construction — no cross-tile
 * stitch pass needed afterward. */
function buildGridGeometry(
  n: number,
  unitAt: (i: number) => readonly [number, number, number],
  radiusAt: (i: number) => number,
  colorOf: (i: number) => RGB,
  skirtDepth: number,
  latLonAt: (i: number) => readonly [number, number],
  radiusAtLatLon: (lat: number, lon: number) => number,
): THREE.BufferGeometry {
  // Growable arrays (the skirt appends past the n×n surface grid).
  const pos: number[] = [];
  const col: number[] = [];
  const nrmArr: number[] = []; // analytic normals, surface vertices only for now
  for (let i = 0; i < n * n; i++) {
    const [ux, uy, uz] = unitAt(i);
    const r = radiusAt(i);
    pos.push(ux * r, uy * r, uz * r);
    const rgb = colorOf(i);
    col.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const [lat, lon] = latLonAt(i);
    const [nx, ny, nz] = analyticNormal(lat, lon, radiusAtLatLon);
    nrmArr.push(nx, ny, nz);
  }
  const q = n - 1;
  const indices: number[] = [];
  for (let row = 0; row < q; row++) {
    for (let c = 0; c < q; c++) {
      const i00 = row * n + c;
      const i10 = row * n + c + 1;
      const i01 = (row + 1) * n + c;
      const i11 = (row + 1) * n + c + 1;
      // CCW in the face's (a, b) plane (u×v = n by construction) — outward on
      // every face without a per-face special case.
      indices.push(i00, i10, i11, i00, i11, i01);
    }
  }

  // Skirts: a vertical apron dropped `skirtDepth` (world units) inward from
  // each of the four edges, filling any crack a coarser neighbour leaves at a
  // mixed-level (CDLOD) boundary. Emitted double-winded so it shows through a
  // crack from either side; each skirt vertex takes its source edge vertex's
  // (analytic) normal (copied below) so it's lit like the surface, not a
  // black sliver. Harmless when neighbours match (it stays hidden below the
  // surface). skirtDepth 0 → no skirt (the ocean and other callers).
  const skirtToEdge: Array<[number, number]> = [];
  if (skirtDepth > 0) {
    const edge = (make: (i: number) => number) => Array.from({ length: n }, (_, i) => make(i));
    const edges = [
      edge((c) => c), // top row (row 0)
      edge((c) => (n - 1) * n + c), // bottom row
      edge((r) => r * n), // left col
      edge((r) => r * n + (n - 1)), // right col
    ];
    for (const e of edges) {
      const start = pos.length / 3; // index of this edge's first skirt vertex
      for (const v of e) {
        const [gx, gy, gz] = unitAt(v);
        pos.push(pos[3 * v]! - gx * skirtDepth, pos[3 * v + 1]! - gy * skirtDepth, pos[3 * v + 2]! - gz * skirtDepth);
        col.push(col[3 * v]!, col[3 * v + 1]!, col[3 * v + 2]!);
      }
      for (let k = 0; k < e.length; k++) skirtToEdge.push([start + k, e[k]!]);
      for (let k = 0; k < e.length - 1; k++) {
        const e0 = e[k]!;
        const e1 = e[k + 1]!;
        const s0 = start + k;
        const s1 = start + k + 1;
        // Two triangles for the quad, then both reversed — view-independent.
        indices.push(e0, e1, s1, e0, s1, s0);
        indices.push(e0, s1, e1, e0, s0, s1);
      }
    }
  }

  // Pad the analytic-normal array out to cover any skirt vertices appended
  // above (placeholders — immediately overwritten by the edge-vertex copy
  // below, exactly like the pre-analytic code did after `computeVertexNormals`).
  while (nrmArr.length < pos.length) nrmArr.push(0, 0, 0);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrmArr), 3));
  geom.setIndex(indices);
  if (skirtToEdge.length > 0) {
    // Give each skirt vertex its edge vertex's (outward) normal, so the double
    // winding doesn't leave a cancelled ~0 normal (which would render black
    // under the directional-only light).
    const nrm = geom.getAttribute('normal') as THREE.BufferAttribute;
    for (const [s, e] of skirtToEdge) nrm.setXYZ(s, nrm.getX(e), nrm.getY(e), nrm.getZ(e));
    nrm.needsUpdate = true;
  }
  return geom;
}

/** Build a whole cube face (the level-0 tile) — the pre-LOD convenience form.
 * Equivalent to `buildTileGeometry` on `{ face, level: 0, ix: 0, iy: 0 }`. */
export function buildFaceGeometry(
  tiles: TilesScene,
  face: number,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
): THREE.BufferGeometry {
  return buildTileGeometry(tiles, { face, level: 0, ix: 0, iy: 0 }, radius, reliefScale, colorAt);
}

/** Reconcile the surface normals of a set of geometries so every coincident
 * vertex position ends up with one shared normal. Analytic normals already
 * make BASE tiles agree by construction (both sides probe the same global
 * field), so this is NOT needed there. It IS needed across adjacent REGION
 * patches: `sampleRegionElevation` clamps its probe to a patch's own bounds,
 * so a patch's edge vertex sees zero outward slope while its neighbour sees
 * the real interior slope — the two one-sided normals disagree and the
 * directional light draws a shading crease (worst at 60× relief). The
 * proper cure is a 1-node halo in the region export, which needs the wasm
 * producer; until then the caller scopes this pass to the handful of mounted
 * region tiles (never the whole globe — that was the O(all-vertices) cost T2
 * deleted). Keying on the exact float32 position triple is safe because
 * shared edge vertices are built bit-identically (`regionPatchUnits` derives
 * them from the same `param`/`faceUnit`). */
export function stitchNormals(geoms: THREE.BufferGeometry[]): void {
  const sums = new Map<string, [number, number, number]>();
  const keyAt = (pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) =>
    `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
  for (const g of geoms) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const key = keyAt(pos, i);
      const s = sums.get(key);
      if (s) {
        s[0] += nrm.getX(i);
        s[1] += nrm.getY(i);
        s[2] += nrm.getZ(i);
      } else {
        sums.set(key, [nrm.getX(i), nrm.getY(i), nrm.getZ(i)]);
      }
    }
  }
  for (const g of geoms) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = sums.get(keyAt(pos, i))!;
      const len = Math.hypot(x, y, z) || 1;
      nrm.setXYZ(i, x / len, y / len, z / len);
    }
    nrm.needsUpdate = true;
  }
}

