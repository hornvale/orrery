/** The vendored wasm binary IS the contract fixture: instantiates
 * `public/hornvale_world.wasm` directly and asserts the strict parser
 * (./scene.ts) accepts the real documents it produces. No committed JSON
 * copy sits between producer and consumer to drift — this is the
 * end-to-end proof. The loader itself lives in ../testHelpers/wasmFixture
 * (a non-test module) so other tests can import it without double-running
 * these tests. */
import { expect, test } from "vitest";
import {
  loadSeed42Tiles,
  loadSeed42System,
  loadSeed42Region,
  loadSeed42Moons,
  loadSeed42Neighbors,
  loadSeed42Eclipses,
} from "../testHelpers/wasmFixture";

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

test("the vendored binary's system moons carry inclination and node", async () => {
  const sys = await loadSeed42System();
  expect(sys.moons.some((m) => m.inclinationDeg > 90)).toBe(true); // the retrograde capture
  for (const m of sys.moons) {
    expect(m.nodeLongitudeDeg).toBeGreaterThanOrEqual(0);
    expect(m.nodeLongitudeDeg).toBeLessThan(360);
  }
});

test("the vendored binary carries the plate and unrest layers", async () => {
  const tiles = await loadSeed42Tiles(64);
  expect(tiles.plate).toHaveLength(tiles.width * tiles.height);
  expect(tiles.unrest).toHaveLength(tiles.width * tiles.height);
  expect(Math.max(...tiles.unrest)).toBeLessThanOrEqual(1);
  expect(Math.min(...tiles.unrest)).toBeGreaterThanOrEqual(0);
  expect(new Set(tiles.plate).size).toBe(16); // seed 42 breaks into 16 plates
});

test("the vendored binary's moons document parses strictly", async () => {
  const moons = await loadSeed42Moons();
  expect(moons.schema).toBe("scene/moons/v1");
  expect(moons.moons).toHaveLength(2); // seed 42 has two moons
  for (const m of moons.moons) {
    expect(m.albedo).toBeGreaterThanOrEqual(0.04);
    expect(m.albedo).toBeLessThanOrEqual(0.5);
    expect(m.cratering).toBeGreaterThanOrEqual(0);
    expect(m.cratering).toBeLessThanOrEqual(1);
    expect(m.mariaFraction).toBeGreaterThanOrEqual(0);
    expect(m.mariaFraction).toBeLessThanOrEqual(1);
    expect(m.tint).toHaveLength(3);
    expect(m.densityGCm3).toBeGreaterThan(0);
    expect(["giant-impact", "capture"]).toContain(m.formation);
  }
});

test("the vendored binary's neighbors document parses strictly", async () => {
  const sky = await loadSeed42Neighbors();
  expect(sky.schema).toBe("scene/neighbors/v1");
  expect(sky.neighbors.length).toBeGreaterThanOrEqual(2);
  expect(sky.neighbors.length).toBeLessThanOrEqual(5);
  expect(sky.stars.length).toBeGreaterThanOrEqual(100);
  expect(sky.stars.length).toBeLessThanOrEqual(300);
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

test("the vendored binary's eclipses document parses strictly", async () => {
  const ecl = await loadSeed42Eclipses(0, 2000);
  expect(ecl.schema).toBe("scene/eclipses/v1");
  expect(ecl.events.length).toBeGreaterThan(0);
  expect(ecl.events.some((e) => e.body === "solar" && e.track !== null)).toBe(true);
  expect(ecl.events.some((e) => e.body === "lunar" && e.track === null)).toBe(true);
});
