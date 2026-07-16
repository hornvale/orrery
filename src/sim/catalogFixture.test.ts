/** The vendored wasm binary IS the contract fixture: instantiates
 * `public/hornvale_world.wasm` directly and asserts the strict parser
 * (./scene.ts) accepts the real documents it produces. No committed JSON
 * copy sits between producer and consumer to drift — this is the
 * end-to-end proof. The loader itself lives in ../testHelpers/wasmFixture
 * (a non-test module) so other tests can import it without double-running
 * these tests. */
import { expect, test } from "vitest";
import { loadSeed42Tiles, loadSeed42System, loadSeed42Region } from "../testHelpers/wasmFixture";

test("the vendored binary's tiles document parses strictly", async () => {
  const tiles = await loadSeed42Tiles(64);
  expect(tiles.schema).toBe("scene/tiles/v1");
  expect(tiles.t_mean_c).toHaveLength(tiles.width * tiles.height);
  expect(tiles.circulationBands).toBe(3); // seed 42 spins Earth-like
});

test("the vendored binary's system document parses strictly", async () => {
  const sys = await loadSeed42System();
  expect(sys.schema).toBe("scene/system/v1");
  expect(sys.moons.length).toBeGreaterThan(0);
});

test("the vendored binary carries the plate and unrest layers", async () => {
  const tiles = await loadSeed42Tiles(64);
  expect(tiles.plate).toHaveLength(tiles.width * tiles.height);
  expect(tiles.unrest).toHaveLength(tiles.width * tiles.height);
  expect(Math.max(...tiles.unrest)).toBeLessThanOrEqual(1);
  expect(Math.min(...tiles.unrest)).toBeGreaterThanOrEqual(0);
  expect(new Set(tiles.plate).size).toBe(16); // seed 42 breaks into 16 plates
});

test("the vendored binary's region document parses strictly", async () => {
  const region = await loadSeed42Region(0, 3, 4, 4, 16);
  expect(region.schema).toBe("scene/tiles-region/v1");
  const nodes = (16 + 1) * (16 + 1);
  expect(region.elevation_m).toHaveLength(nodes);
  expect(region.ocean).toHaveLength(nodes);
  expect(region.biome).toHaveLength(nodes);
  expect(region.plate).toHaveLength(nodes);
  expect(region.unrest).toHaveLength(nodes);
  expect(region.t_mean_c).toHaveLength(nodes);
  expect(region.t_swing_c).toHaveLength(nodes);
  expect(region.moisture).toHaveLength(nodes);
});
