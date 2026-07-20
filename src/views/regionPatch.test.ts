import { describe, expect, it } from "vitest";
import { faceUnit, unitLatLon } from "./cubeSphere";
import { regionPatchUnits, sampleRegionElevation } from "./regionPatch";
import { loadSeed42Region } from "../testHelpers/wasmFixture";
import type { RegionScene } from "../sim/scene";

/** The tile-local face parameter (cubeSphere's internal `param`), recomputed
 * independently here so the registration assertion doesn't just echo the
 * patch builder's own formula back at itself. */
function param(index: number, offset: number, level: number): number {
  return -1 + (2 * (index + offset)) / (1 << level);
}

describe("regionPatchUnits: single-patch registration/seam proof", () => {
  it("builds (samples+1)² unit-length nodes", async () => {
    const region = await loadSeed42Region(0, 3, 4, 4, 16);
    const units = regionPatchUnits(region);
    expect(units).toHaveLength(17 * 17);
    for (const u of units) {
      expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 12);
    }
  });

  it("registers on the globe: the (row 0, col 0) node matches the tile's cube-sphere corner", async () => {
    const region = await loadSeed42Region(0, 3, 4, 4, 16);
    const units = regionPatchUnits(region);
    const corner = units[0]!; // row 0, col 0
    const expected = faceUnit(0, param(4, 0, 3), param(4, 0, 3));
    expect(corner[0]).toBeCloseTo(expected[0], 12);
    expect(corner[1]).toBeCloseTo(expected[1], 12);
    expect(corner[2]).toBeCloseTo(expected[2], 12);
  });

  it(
    "seams with its east neighbour: shared edge nodes coincide exactly",
    async () => {
      // Two fresh wasm instantiations + full genesis, sequentially — each
      // ~8-9s alone, so this needs headroom beyond the default test timeout.
      const region = await loadSeed42Region(0, 3, 4, 4, 16);
      const neighbor = await loadSeed42Region(0, 3, 5, 4, 16);
      const units = regionPatchUnits(region);
      const neighborUnits = regionPatchUnits(neighbor);
      const samples = region.samples;
      const n = samples + 1;
      for (let row = 0; row < n; row++) {
        const right = units[row * n + samples]!; // this patch's right edge (col === samples)
        const left = neighborUnits[row * n + 0]!; // neighbor's left edge (col === 0)
        expect(right[0]).toBeCloseTo(left[0], 12);
        expect(right[1]).toBeCloseTo(left[1], 12);
        expect(right[2]).toBeCloseTo(left[2], 12);
      }
    },
    30_000,
  );
});

describe("sampleRegionElevation", () => {
  it("round-trips: sampling at a node's own (lat, lon) returns that node's elevation", () => {
    const samples = 4;
    const nodes = (samples + 1) * (samples + 1);
    // A synthetic patch (no wasm fixture needed) — only the fields
    // regionPatchUnits/sampleRegionElevation read.
    const region = {
      face: 2,
      level: 2,
      ix: 1,
      iy: 2,
      samples,
      elevation_m: Array.from({ length: nodes }, (_, i) => i * 10),
    } as unknown as RegionScene;
    const units = regionPatchUnits(region);
    for (let i = 0; i < nodes; i++) {
      const { latDeg, lonDeg } = unitLatLon(units[i]!);
      expect(sampleRegionElevation(region, latDeg, lonDeg)).toBeCloseTo(region.elevation_m[i]!, 6);
    }
  });

  it("clamps a probe that steps just past the patch edge to the nearest edge node", () => {
    const samples = 4;
    const nodes = (samples + 1) * (samples + 1);
    const region = {
      face: 0,
      level: 2,
      ix: 1,
      iy: 1,
      samples,
      elevation_m: Array.from({ length: nodes }, (_, i) => i * 10),
    } as unknown as RegionScene;
    // Step just past the patch's (row 0, col 0) corner in (a, b) face
    // parameter space — genuinely off the patch, not just off a node — then
    // convert that (a, b) back to (lat, lon) through the SAME faceUnit /
    // unitLatLon path the patch's own nodes use, so the probe direction is
    // unambiguous (no guessing which way lat/lon moves relative to a/b).
    const a0 = param(1, 0, 2); // this patch's own ix=1 col-0 parameter
    const b0 = param(1, 0, 2); // this patch's own iy=1 row-0 parameter
    const probeUnit = faceUnit(0, a0 - 0.1, b0 - 0.1);
    const { latDeg, lonDeg } = unitLatLon(probeUnit);
    expect(sampleRegionElevation(region, latDeg, lonDeg)).toBe(region.elevation_m[0]);
  });
});
