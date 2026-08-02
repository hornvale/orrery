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

/** An arbitrary (lat, lon) as CONTINUOUS, unclamped node coordinates in this
 * patch's own lattice — column `fc` and row `fr`, each running 0..`samples`
 * across the patch. Inverts the forward projection `regionPatchUnits` uses —
 * face → (a, b) → row/col — the exact algebraic inverse of `param`. A point
 * outside the patch simply lands outside [0, samples]; deciding what to do
 * about that (clamp, round, refuse) belongs to each caller below, which is
 * why this returns the raw coordinates. */
function regionNodeCoords(region: RegionScene, latDeg: number, lonDeg: number): { fc: number; fr: number } {
  const { face, level, ix, iy, samples } = region;
  const u = unitFromLatLon(latDeg, lonDeg);
  const { a, b } = faceParamsAt(face, u);
  const scale = 1 << level;
  return {
    fc: samples * (((a + 1) / 2) * scale - ix),
    fr: samples * (((b + 1) / 2) * scale - iy),
  };
}

/** Whether (lat, lon) falls within this patch's own node lattice — i.e.
 * whether the patch actually HOLDS data there, rather than a clamped
 * stand-in for it. The analytic-normal probe (`worldMesh.ts`) asks this
 * before stepping: a probe that would leave the patch reads the edge value
 * twice and reports zero slope, so the probe steps the other way instead and
 * takes a real one-sided gradient from the interior. */
export function regionContains(region: RegionScene, latDeg: number, lonDeg: number): boolean {
  const { fc, fr } = regionNodeCoords(region, latDeg, lonDeg);
  return fc >= 0 && fc <= region.samples && fr >= 0 && fr <= region.samples;
}

/** The region node nearest an arbitrary (lat, lon) near the patch, as an
 * index into any of the region's per-node layers (`elevation_m`, `biome`,
 * …). Clamps to the patch's own [0, samples] bounds, so a probe that steps
 * just past the patch edge still resolves to a sane (edge) node instead of
 * wrapping into an unrelated one. Factored out of `sampleRegionElevation` so
 * a caller that needs the INDEX itself (e.g. the Voxel style's region
 * builder, whose colour comes from a node index rather than that node's
 * elevation) doesn't re-derive this inversion a second time. */
export function nearestRegionNodeIndex(region: RegionScene, latDeg: number, lonDeg: number): number {
  const { samples } = region;
  const { fc, fr } = regionNodeCoords(region, latDeg, lonDeg);
  const clampedCol = Math.min(samples, Math.max(0, Math.round(fc)));
  const clampedRow = Math.min(samples, Math.max(0, Math.round(fr)));
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
 * the normal to grazing under 60× relief. Clamps to the patch's own bounds,
 * which just outside them reads as a dead-flat slope — so the normal probe
 * asks `regionContains` first and steps INWARD rather than sampling into the
 * clamp, leaving each edge vertex a real one-sided gradient for the scoped
 * region stitch to pair with its neighbour's (see globe.ts
 * `stitchMountedRegions`). */
export function sampleRegionElevationBilinear(region: RegionScene, latDeg: number, lonDeg: number): number {
  const { samples } = region;
  const { fc, fr } = regionNodeCoords(region, latDeg, lonDeg);
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
