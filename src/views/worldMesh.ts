/** The shared face-mesh builder: turns `scene/tiles/v1` into a colored,
 * optionally-displaced cube-sphere face — the geometry both `./globe.ts`
 * (real relief, schematic globe radius) and `./system.ts` (smooth, AU-scale
 * world sphere) build their faces from. One mismatch here shows up as two
 * views disagreeing about the same world.
 */
import * as THREE from 'three';
import type { RegionScene, TilesScene } from '../sim/scene';
import type { RGB } from './lens';
import { TILE_QUADS, tileGrid, unitFromLatLon, unitLatLon, type TileId } from './cubeSphere';
import { regionPatchUnits, sampleRegionElevationBilinear } from './regionPatch';

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

/** Build one cube-sphere *tile*'s displaced, vertex-colored geometry, at
 * whatever `level`/`ix`/`iy` the `TileId` names (a level-0 tile is the whole
 * face; deeper tiles are the adaptive-LOD quadtree's finer squares). Each
 * tile is a uniform `TILE_QUADS`×`TILE_QUADS` grid, so a deeper level samples
 * the same data on a finer lattice — smoother relief where the camera is
 * close. `radius` is the rendered sphere's undisplaced radius (world units);
 * `reliefScale` is the exaggeration multiple applied to elevation before it
 * displaces the surface — 0 gives a smooth sphere. */
export function buildTileGeometry(
  tiles: TilesScene,
  tile: TileId,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  skirtDepth = 0,
): THREE.BufferGeometry {
  const grid = tileGrid(tile);
  const n = TILE_QUADS + 1;
  // A pure function of (lat, lon) — the SAME path a vertex's own displaced
  // position uses — so the analytic normal probe (which evaluates this at
  // lat/lon-offset neighbours, not just grid vertices) agrees bit-for-bit
  // with whatever any OTHER tile computes at that same (lat, lon).
  const radiusAtLatLon = (lat: number, lon: number): number =>
    radius * (1 + (reliefScale * sampleElevationBilinear(tiles, lat, lon)) / REFERENCE_RADIUS_M);
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
 * reads). */
export function buildRegionTileGeometry(
  region: RegionScene,
  radius: number,
  reliefScale: number,
  colorAt: (i: number) => RGB,
  skirtDepth = 0,
): THREE.BufferGeometry {
  const units = regionPatchUnits(region);
  const n = region.samples + 1;
  // Pure function of (lat, lon) via the region's own field (see
  // `sampleRegionElevation`) — the counterpart of `buildTileGeometry`'s
  // `radiusAtLatLon`, used by the analytic normal probe.
  const radiusAtLatLon = (lat: number, lon: number): number =>
    radius * (1 + (reliefScale * sampleRegionElevationBilinear(region, lat, lon)) / REFERENCE_RADIUS_M);
  return buildGridGeometry(
    n,
    (i) => units[i]!,
    (i) => radius * (1 + (reliefScale * region.elevation_m[i]!) / REFERENCE_RADIUS_M),
    (i) => colorAt(i), // a region node's index IS the colour index
    skirtDepth,
    (i) => {
      const { latDeg, lonDeg } = unitLatLon(units[i]!);
      return [latDeg, lonDeg];
    },
    radiusAtLatLon,
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

