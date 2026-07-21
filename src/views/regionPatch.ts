/** The pure-geometry patch builder for a `scene/tiles-region/v1` document —
 * the seed of the future LOD renderer (orrery#2). Builds the (samples+1)²
 * node unit vectors of a regional tile from the SAME cube-sphere projection
 * the globe mesh uses, so a patch registers correctly on the globe and
 * shares exact edge points with its neighbours (no seam gaps). This is a
 * geometry proof only — no WebGL rendering here. */
import { faceParamsAt, faceUnit, unitFromLatLon, type V3 } from "./cubeSphere";
import type { RegionScene } from "../sim/scene";

/** The tile-local face parameter (cubeSphere's internal `param`, replicated). */
function param(index: number, offset: number, level: number): number {
  return -1 + (2 * (index + offset)) / (1 << level);
}

/** The (samples+1)² node unit vectors of a regional tile, in the document's
 * row-major order (row = iy/`b` outer, col = ix/`a` inner) so node `i`'s unit
 * vector aligns with `region.elevation_m[i]` and the other per-node layers.
 * Built from the SAME cube-sphere projection the globe mesh uses, so a patch
 * registers on the globe and shares exact edge points with its neighbours. */
export function regionPatchUnits(region: RegionScene): V3[] {
  const { face, level, ix, iy, samples } = region;
  const units: V3[] = [];
  for (let row = 0; row <= samples; row++) {
    const b = param(iy, row / samples, level);
    for (let col = 0; col <= samples; col++) {
      const a = param(ix, col / samples, level);
      units.push(faceUnit(face, a, b));
    }
  }
  return units;
}

/** The region node nearest an arbitrary (lat, lon) near the patch, as an
 * index into any of the region's per-node layers (`elevation_m`, `biome`,
 * …). Inverts the forward projection `regionPatchUnits` uses — face → (a, b)
 * → row/col — the exact algebraic inverse of `param`. Clamps to the patch's
 * own [0, samples] bounds, so a probe that steps just past the patch edge
 * still resolves to a sane (edge) node instead of wrapping into an unrelated
 * one. Factored out of `sampleRegionElevation` so a caller that needs the
 * INDEX itself (e.g. the Voxel style's region builder, whose colour comes
 * from a node index rather than that node's elevation) doesn't re-derive
 * this inversion a second time. */
export function nearestRegionNodeIndex(region: RegionScene, latDeg: number, lonDeg: number): number {
  const { face, level, ix, iy, samples } = region;
  const u = unitFromLatLon(latDeg, lonDeg);
  const { a, b } = faceParamsAt(face, u);
  const scale = 1 << level;
  const col = Math.round(samples * (((a + 1) / 2) * scale - ix));
  const row = Math.round(samples * (((b + 1) / 2) * scale - iy));
  const clampedCol = Math.min(samples, Math.max(0, col));
  const clampedRow = Math.min(samples, Math.max(0, row));
  return clampedRow * (samples + 1) + clampedCol;
}

/** Sample `region.elevation_m` at an arbitrary (lat, lon) near the patch —
 * the region counterpart of `worldMesh.ts`'s `sampleTile`, used by analytic
 * surface normals to evaluate a small lat/lon-offset neighbour through the
 * SAME field the patch's own vertex positions read (so the normal is a pure
 * function of (lat, lon) + this field, per `buildRegionTileGeometry`). */
export function sampleRegionElevation(region: RegionScene, latDeg: number, lonDeg: number): number {
  return region.elevation_m[nearestRegionNodeIndex(region, latDeg, lonDeg)]!;
}

/** Bilinearly-interpolated region elevation — the continuous counterpart of
 * `sampleRegionElevation`, for the same reason `sampleElevationBilinear` exists
 * for base tiles: the geometry (and the analytic normal taken from its
 * gradient) must sample elevation continuously, or a nearest-node step spikes
 * the normal to grazing under 60× relief. Clamps to the patch's own bounds
 * (edge normals stay one-sided there — the scoped region stitch reconciles
 * those; see globe.ts `stitchMountedRegions`). */
export function sampleRegionElevationBilinear(region: RegionScene, latDeg: number, lonDeg: number): number {
  const { face, level, ix, iy, samples } = region;
  const u = unitFromLatLon(latDeg, lonDeg);
  const { a, b } = faceParamsAt(face, u);
  const scale = 1 << level;
  const fc = samples * (((a + 1) / 2) * scale - ix);
  const fr = samples * (((b + 1) / 2) * scale - iy);
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const tx = fc - c0;
  const ty = fr - r0;
  const n = samples + 1;
  const clamp = (v: number): number => Math.min(samples, Math.max(0, v));
  const at = (r: number, c: number): number => region.elevation_m[clamp(r) * n + clamp(c)]!;
  const top = at(r0, c0) * (1 - tx) + at(r0, c0 + 1) * tx;
  const bot = at(r0 + 1, c0) * (1 - tx) + at(r0 + 1, c0 + 1) * tx;
  return top * (1 - ty) + bot * ty;
}
