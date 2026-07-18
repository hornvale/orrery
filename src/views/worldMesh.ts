/** The shared face-mesh builder: turns `scene/tiles/v1` into a colored,
 * optionally-displaced cube-sphere face — the geometry both `./globe.ts`
 * (real relief, schematic globe radius) and `./system.ts` (smooth, AU-scale
 * world sphere) build their faces from. One mismatch here shows up as two
 * views disagreeing about the same world.
 */
import * as THREE from 'three';
import type { TilesScene } from '../sim/scene';
import type { RGB } from './lens';
import { TILE_QUADS, tileGrid, type TileId } from './cubeSphere';

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
): THREE.BufferGeometry {
  const grid = tileGrid(tile);
  const n = TILE_QUADS + 1;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  for (let i = 0; i < n * n; i++) {
    const lat = grid.lats[i]!;
    const lon = grid.lons[i]!;
    const elevation = sampleTile(tiles, lat, lon, 'elevation_m');
    const radiusAt = radius * (1 + (reliefScale * elevation) / REFERENCE_RADIUS_M);
    positions[3 * i] = grid.units[3 * i]! * radiusAt;
    positions[3 * i + 1] = grid.units[3 * i + 1]! * radiusAt;
    positions[3 * i + 2] = grid.units[3 * i + 2]! * radiusAt;

    const rgb = colorAt(tileIndex(tiles, lat, lon));
    colors[3 * i] = rgb[0] / 255;
    colors[3 * i + 1] = rgb[1] / 255;
    colors[3 * i + 2] = rgb[2] / 255;
  }
  const indices: number[] = [];
  for (let row = 0; row < TILE_QUADS; row++) {
    for (let col = 0; col < TILE_QUADS; col++) {
      const i00 = row * n + col;
      const i10 = row * n + col + 1;
      const i01 = (row + 1) * n + col;
      const i11 = (row + 1) * n + col + 1;
      // CCW in the face's (a, b) plane, whose u×v = n by construction
      // (verified for all six faces) — this winding is outward-facing on
      // every face without a per-face special case.
      indices.push(i00, i10, i11, i00, i11, i01);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
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

/** Average vertex normals across geometries wherever positions coincide.
 *
 * Each face's `computeVertexNormals` only sees its own triangles, so a
 * vertex on a cube edge gets a one-sided normal — and the face on the other
 * side gets a *different* one-sided normal for the bit-identical position
 * (`cubeSphere.ts` guarantees shared edges/corners can't crack). Under
 * exaggerated relief the two averages diverge hard, and directional light
 * paints every cube edge as a seam. Summing and renormalizing across all
 * coincident vertices gives both sides the same normal, which is what
 * removes the seam; keying on the exact float32 position triple is safe
 * because shared edge vertices are computed bit-identically per face. */
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
