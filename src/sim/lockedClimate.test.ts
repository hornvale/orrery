/** Tests for ./lockedClimate: the producer-pinned golden for seed 8 (tidally
 * locked) plus the seasonalTemperatureAt dispatcher. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lockedTemperatureAt, seasonalTemperatureAt, lensTemperatureAt } from "./lockedClimate";
import { parseTiles } from "./scene";
import { readOut } from "./catalog";
import type { TilesScene } from "./scene";

/** Seed 8's `scene/system/v1` orbital elements (`hornvale scene system
 * --world <seed-8>`), hardcoded here rather than re-parsed per test run:
 * seed 8 is tidally locked (obliquity ~21.8°), the world this golden was
 * captured against (`windows/scene/examples/locked_temperature_golden.rs`).
 */
const SEED8 = {
  obliquityDeg: 21.786886,
  yearPhaseOffset: 0.55227045,
  luminosityRel: 0.40864556,
  orbitAu: 0.68649318,
};

/** `insolation_rel` (`hornvale_astronomy::insolation_rel` — the single
 * shared definition, SKY-15): `L / a²`, relative to Earth. */
const insolation = SEED8.luminosityRel / (SEED8.orbitAu * SEED8.orbitAu);

async function loadSeed8Tiles(width: number): Promise<TilesScene> {
  const bytes = readFileSync("public/hornvale_world.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports as any;
  e.hw_new(8n);
  if (e.hw_scene_tiles(width) !== 0) throw new Error(readOut(e));
  return parseTiles(readOut(e));
}

test("lockedTemperatureAt reproduces the Rust producer's locked-world golden (seed 8)", async () => {
  const tiles = await loadSeed8Tiles(64);
  expect(tiles.locked).toBe(true);
  const lines = readFileSync("testdata/locked-temperature-golden-seed8.csv", "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const [nodeStr, dayStr, tStr] = line.split(",");
    const node = Number(nodeStr);
    const day = Number(dayStr);
    const t = Number(tStr);
    const got = lockedTemperatureAt(
      tiles,
      node,
      day,
      tiles.season_period_days,
      SEED8.obliquityDeg,
      SEED8.yearPhaseOffset,
      insolation,
    );
    expect(Math.abs(got - t)).toBeLessThan(1e-3);
  }
});

test("seasonalTemperatureAt routes a locked tiles document to lockedTemperatureAt", async () => {
  const tiles = await loadSeed8Tiles(64);
  const ctx = { yearPhaseOffset: SEED8.yearPhaseOffset, obliquityDeg: SEED8.obliquityDeg, insolation, dayLengthStd: null };
  const viaDispatcher = seasonalTemperatureAt(tiles, 96, 0, ctx);
  const direct = lockedTemperatureAt(tiles, 96, 0, tiles.season_period_days, ctx.obliquityDeg, ctx.yearPhaseOffset, ctx.insolation);
  expect(viaDispatcher).toBe(direct);
});

test("seasonalTemperatureAt routes a spinning tiles document to temperatureAt", () => {
  const spinning = {
    locked: false,
    t_mean_c: [10],
    t_swing_c: [8],
    season_period_days: 360,
  } as unknown as TilesScene;
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: null };
  const got = seasonalTemperatureAt(spinning, 0, 90, ctx);
  // 90 days at offset 0.2, year 360: phase = frac(90/360+0.2) = 0.45
  const expected = 10 + 8 * Math.sin(2 * Math.PI * 0.45);
  expect(Math.abs(got - expected)).toBeLessThan(1e-9);
});

/** A one-tile-of-interest spinning fixture at the equator (lat 0 exactly:
 * `tileLatLon`'s row 0 of a height-1 grid lands at `90 - 0.5/1*180 == 0`),
 * flat mean/no seasonal swing so only the diurnal term (Task 6) can move the
 * result — isolates `lensTemperatureAt`'s new behavior from the pre-existing
 * seasonal sinusoid. Tile 0 (of a width-4, height-1 grid) sits at longitude
 * `(0+0.5)/4*360-180 == -135`, so its local solar time is the planet-wide
 * `dayFraction` shifted by `-135/360 == -0.375` (see `tileLatLon`). */
function dryEquatorialTile(): TilesScene {
  return {
    locked: false,
    width: 4,
    height: 1,
    t_mean_c: [10, 10, 10, 10],
    t_swing_c: [0, 0, 0, 0],
    tDiurnalAmpC: [6, 0, 0, 0],
    season_period_days: 360,
  } as unknown as TilesScene;
}

test("lensTemperatureAt: the local afternoon is warmer than local pre-dawn at a dry tile", () => {
  const tiles = dryEquatorialTile();
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: 1 };
  // Tile 0 is at longitude -135 (lon/360 == -0.375), so its local solar time
  // is `frac(dayFraction - 0.375)`. Pick day_fraction so tile 0's LOCAL solar
  // time lands exactly at PEAK_FRAC (0.6, local afternoon) for one call and
  // near local pre-dawn (0.05) for the other — same integer day (100) so the
  // seasonal term (which is flat here anyway: t_swing_c is all zero) is
  // identical either way; only the diurnal pulse differs.
  const afternoon = lensTemperatureAt(tiles, 0, 100.975, ctx); // local solar time = frac(0.975 - 0.375) = 0.6
  const preDawn = lensTemperatureAt(tiles, 0, 100.425, ctx); // local solar time = frac(0.425 - 0.375) = 0.05
  expect(afternoon).toBeGreaterThan(preDawn);
});

test("lensTemperatureAt averages (to tol) to the non-diurnal value over a full day", () => {
  const tiles = dryEquatorialTile();
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: 1 };
  const n = 1000;
  let sum = 0;
  for (let k = 0; k < n; k++) sum += lensTemperatureAt(tiles, 0, k / n, ctx);
  const nonDiurnal = seasonalTemperatureAt(tiles, 0, 0, ctx);
  expect(Math.abs(sum / n - nonDiurnal)).toBeLessThan(1e-2);
});

test("lensTemperatureAt adds nothing on a locked world (no diurnal_amp branch)", () => {
  const tiles = { ...dryEquatorialTile(), locked: true, elevation_m: [0, 0, 0, 0], sea_level_m: 0 } as unknown as TilesScene;
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: 1 };
  expect(lensTemperatureAt(tiles, 0, 100.6, ctx)).toBe(seasonalTemperatureAt(tiles, 0, 100.6, ctx));
});

test("lensTemperatureAt adds nothing when dayLengthStd is null (no day length to swing over)", () => {
  const tiles = dryEquatorialTile();
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: null };
  expect(lensTemperatureAt(tiles, 0, 100.6, ctx)).toBe(seasonalTemperatureAt(tiles, 0, 100.6, ctx));
});

test("lensTemperatureAt: seasonDayOverride pins the season while the diurnal pulse still tracks live day", () => {
  const tiles = dryEquatorialTile();
  tiles.t_swing_c = [9, 9, 9, 9]; // give the season a real signal to hold still against
  tiles.tDiurnalAmpC = [12, 12, 12, 12]; // and a real diurnal signal to keep tracking
  const ctx = { yearPhaseOffset: 0.2, obliquityDeg: 21, insolation: 1, dayLengthStd: 1, seasonDayOverride: 100.6 };
  // Same day_fraction (.6), far-apart integer days — the season term must
  // read `seasonDayOverride` (100.6) both times, not the live `day`. Tile 0
  // sits at a nonzero longitude (-135), so its local solar time is off the
  // waveform's flat-derivative peak — comparing floats derived from very
  // different day magnitudes (100.6 vs 400.6) is only equal to floating-point
  // tolerance, not bit-for-bit.
  const a = lensTemperatureAt(tiles, 0, 100.6, ctx);
  const b = lensTemperatureAt(tiles, 0, 400.6, ctx);
  expect(Math.abs(a - b)).toBeLessThan(1e-9);
  // Without the override, the same pair differs (the season actually moved).
  const free = { ...ctx, seasonDayOverride: undefined };
  const c = lensTemperatureAt(tiles, 0, 100.6, free);
  const d = lensTemperatureAt(tiles, 0, 400.6, free);
  expect(c).not.toBe(d);
  // The other half of the title: with the season pinned (override held at
  // 100.6), advancing the *fractional* day must still move the temperature —
  // the diurnal pulse tracks the live clock, not the frozen season. 100.6 and
  // 100.1 share the pinned season but sit at different local solar times.
  const morning = lensTemperatureAt(tiles, 0, 100.1, ctx);
  expect(Math.abs(morning - a)).toBeGreaterThan(0.5);
});
