import { describe, expect, it } from "vitest";
import { faceUnit } from "./cubeSphere";
import { regionPatchUnits } from "./regionPatch";
import { loadSeed42Region } from "../testHelpers/wasmFixture";

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
