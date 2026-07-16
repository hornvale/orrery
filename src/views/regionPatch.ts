/** The pure-geometry patch builder for a `scene/tiles-region/v1` document —
 * the seed of the future LOD renderer (orrery#2). Builds the (samples+1)²
 * node unit vectors of a regional tile from the SAME cube-sphere projection
 * the globe mesh uses, so a patch registers correctly on the globe and
 * shares exact edge points with its neighbours (no seam gaps). This is a
 * geometry proof only — no WebGL rendering here. */
import { faceUnit, type V3 } from "./cubeSphere";
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
