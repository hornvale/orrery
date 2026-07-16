/** Tests for ./climate: the producer-pinned equivalence against the frozen
 * seed-42 triples, plus plain unit tests for windAt/coldestC. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { temperatureAt, windAt, coldestC } from "./climate";
import { loadSeed42Tiles, loadSeed42Region } from "../testHelpers/wasmFixture";
import type { TilesScene } from "./scene";

const triples = JSON.parse(readFileSync("testdata/climate-triples-seed-42.json", "utf8"));

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
    expect(Math.abs(temperatureAt(tiles, row.i, row.day) - row.t)).toBeLessThan(0.001);
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
    // coefficients while the golden is the sim's full-precision value.
    expect(Math.abs(temperatureAt(region, node, day) - t)).toBeLessThan(1e-3);
  }
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
