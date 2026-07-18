/** Tests for ./climate: the producer-pinned equivalence against the frozen
 * seed-42 triples, plus plain unit tests for windAt/coldestC. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { temperatureAt, windAt, coldestC } from "./climate";
import { loadSeed42Tiles, loadSeed42Region } from "../testHelpers/wasmFixture";
import type { TilesScene } from "./scene";

const triples = JSON.parse(readFileSync("testdata/climate-triples-seed-42.json", "utf8"));

// Seed 42's genesis year-phase offset (`scene/system/v1`'s `year_phase_offset`),
// the value the v6 producer phases its seasonal temperature on. The goldens
// below were regenerated against that producer (The Wandering Sun), so the
// client reconstruction is exercised at the real offset, not 0.
const SEED42_YEAR_PHASE_OFFSET = 0.20941868;

test("temperatureAt reproduces the Rust producer's temperature_at triples", async () => {
  const tiles = await loadSeed42Tiles(triples.width);
  for (const row of triples.rows) {
    // Tolerance, not exact equality: the client reconstructs temperatureAt
    // from the quantized t_mean_c/t_swing_c coefficients, while the Rust
    // golden `row.t` is the quantized final temperature_at value itself —
    // two different quantization paths to the same physics, so they agree
    // to quantization precision (~1e-5 degC here). 0.001 degC is loose enough
    // to absorb that noise but tight enough to catch any real evaluator
    // divergence, which would show up as whole degrees of drift.
    expect(
      Math.abs(temperatureAt(tiles, row.i, row.day, SEED42_YEAR_PHASE_OFFSET) - row.t),
    ).toBeLessThan(0.001);
  }
});

test("temperatureAt reproduces the Rust producer's regional temperature triples", async () => {
  const region = await loadSeed42Region(0, 3, 4, 4, 16);
  const lines = readFileSync("testdata/region-temperature-golden.csv", "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const [nodeStr, dayStr, tStr] = line.split(",");
    const node = Number(nodeStr);
    const day = Number(dayStr);
    const t = Number(tStr);
    // Same tolerance rationale as the global triples test above: the client
    // reconstructs temperatureAt from the quantized regional t_mean_c/t_swing_c
    // coefficients while the golden is the sim's full-precision value, both at
    // seed 42's real year-phase offset (v6 producer).
    expect(Math.abs(temperatureAt(region, node, day, SEED42_YEAR_PHASE_OFFSET) - t)).toBeLessThan(1e-3);
  }
});

test("temperatureAt's seasonal peak tracks a nonzero yearPhaseOffset", () => {
  // Mirrors the Rust producer's own
  // spinning_seasonal_peak_tracks_the_year_phase_offset (domains/climate/src/
  // temperature.rs, The Wandering Sun Task 2): a hand-built single-tile
  // fixture, not the wasm golden, so this test exercises the offset term in
  // isolation. Northern summer (peak) is at frac(day/year + offset) = 0.25.
  const year = 360;
  const offset = 0.2;
  const src = { t_mean_c: [10], t_swing_c: [8], season_period_days: year };
  const wrap = (phase: number) => ((phase % 1) + 1) % 1;
  const summerDay = wrap(0.25 - offset) * year;
  const winterDay = wrap(0.75 - offset) * year;
  const equinoxDay = wrap(0 - offset) * year;
  expect(temperatureAt(src, 0, summerDay, offset)).toBeGreaterThan(temperatureAt(src, 0, winterDay, offset) + 1);
  expect(Math.abs(temperatureAt(src, 0, equinoxDay, offset) - 10)).toBeLessThan(0.2);
});

test("a nonzero yearPhaseOffset actually changes temperatureAt at a fixed day (mutation check)", () => {
  // Guards against an offset parameter that's accepted but silently ignored:
  // the same tile/day must disagree between offset 0 and offset 0.2.
  const src = { t_mean_c: [10], t_swing_c: [8], season_period_days: 360 };
  expect(temperatureAt(src, 0, 90, 0)).not.toBeCloseTo(temperatureAt(src, 0, 90, 0.2), 5);
});

test("windAt buckets by latitude and alternates direction", () => {
  expect(windAt(3, 0).band).toBe(0);
  expect(windAt(3, 0).direction).toBe("easterly");
  expect(windAt(3, 45).band).toBe(1);
  expect(windAt(3, 45).direction).toBe("westerly");
  expect(windAt(3, 90).band).toBe(2); // clamped
});

test("coldestC is mean minus the swing magnitude", () => {
  const tiles = { t_mean_c: [10], t_swing_c: [-8] } as unknown as TilesScene;
  expect(coldestC(tiles, 0)).toBe(2);
});
