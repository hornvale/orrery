/** Quadtree cube-sphere tile addressing. Six faces, each an axis-aligned
 * square in (a, b) ∈ [-1,1]²; a tile at `level` is one of 2^level × 2^level
 * squares per face. All grid parameters are dyadic rationals, and adjacent
 * faces share pre-normalization edge points exactly, so shared edges/corners
 * produce bit-identical unit vectors — tile seams cannot crack. */
export type V3 = [number, number, number];
export interface TileId { face: number; level: number; ix: number; iy: number }

/** Quads per tile side (65 vertices). One uniform grid per tile — the layout
 * CDLOD geomorphing needs later; seams are handled by skirts, not stitching. */
export const TILE_QUADS = 64;

const FACES: { n: V3; u: V3; v: V3 }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export function tileKey(t: TileId): string {
  return `${t.face}:${t.level}:${t.ix}:${t.iy}`;
}

export function children(t: TileId): [TileId, TileId, TileId, TileId] {
  const l = t.level + 1;
  const x = t.ix * 2;
  const y = t.iy * 2;
  return [
    { face: t.face, level: l, ix: x, iy: y },
    { face: t.face, level: l, ix: x + 1, iy: y },
    { face: t.face, level: l, ix: x, iy: y + 1 },
    { face: t.face, level: l, ix: x + 1, iy: y + 1 },
  ];
}

export function parent(t: TileId): TileId | null {
  if (t.level === 0) return null;
  return { face: t.face, level: t.level - 1, ix: t.ix >> 1, iy: t.iy >> 1 };
}

export function faceUnit(face: number, a: number, b: number): V3 {
  const f = FACES[face]!;
  const x = f.n[0] + a * f.u[0] + b * f.v[0];
  const y = f.n[1] + a * f.u[1] + b * f.v[1];
  const z = f.n[2] + a * f.u[2] + b * f.v[2];
  const len = Math.sqrt(x * x + y * y + z * z);
  return [x / len, y / len, z / len];
}

/** Matches gg-terrain's latlon_to_unit: lat = asin(z), lon = atan2(y, x). */
export function unitLatLon(u: V3): { latDeg: number; lonDeg: number } {
  const latDeg = (Math.asin(Math.min(1, Math.max(-1, u[2]))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  return { latDeg, lonDeg };
}

/** Inverse of `unitLatLon`: the unit vector at (lat, lon) — a pure spherical
 * parameterization with no face/tile involved at all. This is the read half
 * of the (lat,lon) ⇄ unit round trip analytic surface normals depend on:
 * two points built from the same global (lat, lon) coordinate come out
 * bit-identical no matter which tile or face computed them, which is what
 * lets adjacent tiles agree on a shared-edge normal without a post-hoc
 * cross-tile stitch (see `worldMesh.ts`'s `analyticNormal`). */
export function unitFromLatLon(latDeg: number, lonDeg: number): V3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
}

/** Project unit vector `u` onto `face`'s square, returning its (a, b) face
 * parameters — the forced-face counterpart to `containingTile`'s
 * auto-detected one. Used to locate a (lat, lon) point within a *specific*
 * region patch's own node lattice (`regionPatch.ts`'s elevation sampler),
 * where the face is already known and mustn't be re-derived from `u`. */
export function faceParamsAt(face: number, u: V3): { a: number; b: number } {
  const f = FACES[face]!;
  const denom = u[0] * f.n[0] + u[1] * f.n[1] + u[2] * f.n[2];
  const a = (u[0] * f.u[0] + u[1] * f.u[1] + u[2] * f.u[2]) / denom;
  const b = (u[0] * f.v[0] + u[1] * f.v[1] + u[2] * f.v[2]) / denom;
  return { a, b };
}

/** Face parameter of a tile-grid node: dyadic, exact in f64. */
function param(index: number, offset: number, level: number): number {
  return -1 + (2 * (index + offset)) / (1 << level);
}

export function tileCenterUnit(t: TileId): V3 {
  return faceUnit(t.face, param(t.ix, 0.5, t.level), param(t.iy, 0.5, t.level));
}

export function tileEdgeLenM(level: number, radiusM: number): number {
  return ((Math.PI / 2) * radiusM) / (1 << level);
}

/** Deepest level: ~1.5 m vertex spacing, clamped to [3, 18]. */
export function maxLevel(radiusM: number): number {
  const l = Math.ceil(Math.log2(((Math.PI / 2) * radiusM) / (TILE_QUADS * 1.5)));
  return Math.min(18, Math.max(3, l));
}

export interface TileGrid { lats: Float64Array; lons: Float64Array; units: Float64Array }

/** (N+1)×(N+1) grid, row-major over iy (b) then ix (a). Grid nodes at tile
 * borders are shared dyadic parameters, so neighbors at the same level get
 * bit-identical unit vectors along shared edges. */
export function tileGrid(t: TileId): TileGrid {
  const n = TILE_QUADS + 1;
  const lats = new Float64Array(n * n);
  const lons = new Float64Array(n * n);
  const units = new Float64Array(3 * n * n);
  for (let row = 0; row < n; row++) {
    const b = param(t.iy, row / TILE_QUADS, t.level);
    for (let col = 0; col < n; col++) {
      const a = param(t.ix, col / TILE_QUADS, t.level);
      const u = faceUnit(t.face, a, b);
      const i = row * n + col;
      const { latDeg, lonDeg } = unitLatLon(u);
      lats[i] = latDeg;
      lons[i] = lonDeg;
      units[3 * i] = u[0];
      units[3 * i + 1] = u[1];
      units[3 * i + 2] = u[2];
    }
  }
  return { lats, lons, units };
}

/** Base LOD level: matches the 512-wide tile data at the whole-globe view (a
 * level-0 face under-samples it ~2×). */
export const LOD_MIN_LEVEL = 1;
/** Deepest uniform LOD level: past this, a finer lattice only interpolates
 * the same data (smoother silhouette, no new detail) at a steep triangle
 * cost, so the uniform scheme stops here. Per-tile CDLOD (only near tiles go
 * deeper) is where higher levels earn their cost — the next stage. */
export const LOD_MAX_LEVEL = 3;

/** The uniform LOD level for the globe, chosen from how close the camera is.
 * `distance` is camera-to-globe-centre, `radius` the undisplaced globe radius.
 * Far away → `LOD_MIN_LEVEL`; each halving of the camera's altitude above the
 * surface adds one level, clamped to `[LOD_MIN_LEVEL, LOD_MAX_LEVEL]`.
 * Monotonic in closeness, so a caller rebuilds only when the returned level
 * changes (a few times across a zoom, not per frame). Uniform across the
 * globe — no cross-level T-junctions to skirt. */
export function globeLodLevel(distance: number, radius: number): number {
  const altitude = Math.max(distance - radius, radius * 0.01); // never divide by ~0 at the surface
  const steps = Math.floor(Math.log2(radius / altitude));
  return Math.min(LOD_MAX_LEVEL, Math.max(LOD_MIN_LEVEL, LOD_MIN_LEVEL + Math.max(0, steps)));
}

/** How aggressively CDLOD subdivides: a tile splits into its four children
 * while the camera is within this multiple of the tile's world edge length of
 * its centre. Higher → finer (tiles split from farther out). Kept modest so
 * the default whole-globe view stays at the base level (a stable set under the
 * diurnal spin — no rebuild churn); zooming in past it engages the finer
 * levels, where the freeze-spin toggle holds the set still to inspect. */
export const LOD_SPLIT_FACTOR = 1.5;
/** Deepest CDLOD level — only tiles right under the camera reach it, so it can
 * sit deeper than the uniform cap without a whole-globe triangle blow-up. */
export const LOD_CDLOD_MAX_LEVEL = 4;

/** Select the leaf tiles for a camera at `cameraPos` (world units; globe
 * centred at the origin, undisplaced radius `radius`): a quadtree descent from
 * the six level-0 faces that subdivides a tile only while the camera is within
 * `splitFactor × edgeLength(level)` of the tile's centre and its level is
 * below `maxLevel`. Near the camera → fine tiles; the far side stays coarse
 * (level 0), so the detail is paid only where it is seen. Deterministic; call
 * it against the spin-corrected camera and rebuild when the returned set
 * changes. */
export function selectTiles(
  cameraPos: V3,
  radius: number,
  splitFactor = LOD_SPLIT_FACTOR,
  maxLevel = LOD_CDLOD_MAX_LEVEL,
  minLevel = 0,
): TileId[] {
  const out: TileId[] = [];
  const [cx, cy, cz] = cameraPos;
  const visit = (t: TileId): void => {
    if (t.level >= maxLevel) {
      out.push(t);
      return;
    }
    if (t.level < minLevel) {
      // Below the floor: always subdivide, so even the far side never renders
      // coarser than the data-matching base level.
      for (const child of children(t)) visit(child);
      return;
    }
    const c = tileCenterUnit(t);
    const dx = cx - c[0] * radius;
    const dy = cy - c[1] * radius;
    const dz = cz - c[2] * radius;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < splitFactor * tileEdgeLenM(t.level, radius)) {
      for (const child of children(t)) visit(child);
    } else {
      out.push(t);
    }
  };
  for (let face = 0; face < 6; face++) visit({ face, level: 0, ix: 0, iy: 0 });
  return out;
}

/** Tile at `level` whose face-square contains unit vector u: pick the face
 * by dominant axis, then locate (a, b) by central projection onto it. */
export function containingTile(u: V3, level: number): TileId {
  const ax = Math.abs(u[0]);
  const ay = Math.abs(u[1]);
  const az = Math.abs(u[2]);
  let face: number;
  if (ax >= ay && ax >= az) face = u[0] >= 0 ? 0 : 1;
  else if (ay >= ax && ay >= az) face = u[1] >= 0 ? 2 : 3;
  else face = u[2] >= 0 ? 4 : 5;
  const f = FACES[face]!;
  const denom = u[0] * f.n[0] + u[1] * f.n[1] + u[2] * f.n[2];
  const a = (u[0] * f.u[0] + u[1] * f.u[1] + u[2] * f.u[2]) / denom;
  const b = (u[0] * f.v[0] + u[1] * f.v[1] + u[2] * f.v[2]) / denom;
  const scale = 1 << level;
  const clampIdx = (p: number) => Math.min(scale - 1, Math.max(0, Math.floor(((p + 1) / 2) * scale)));
  return { face, level, ix: clampIdx(a), iy: clampIdx(b) };
}
