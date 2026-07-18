/** Client-side reconstruction of a tidally-locked world's librating-
 * substellar temperature — the seasonal signal `temperatureAt` (./climate)
 * does not cover (that formula is spinning-only; a locked world has no year
 * phase organizing latitude-band seasons). Mirrors the producer's
 * `RotationRegime::Locked` branch of `temperature_at`
 * (`domains/climate/src/temperature.rs` + `domains/climate/src/
 * substellar.rs`) in TS, pinned by a producer-sourced golden (The Isotherm
 * rule — never a client reconstruction of itself). */
import type { SystemScene, TilesScene } from "./scene";
import { temperatureAt } from "./climate";
import { diurnalWaveform } from "./diurnal";

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

/** Dry-adiabatic-ish lapse rate, °C lost per meter of elevation above sea
 * level — mirrors `LAPSE_C_PER_M` in `domains/climate/src/temperature.rs`
 * (`6.5 / 1000.0`). */
const LAPSE_C_PER_M = 6.5 / 1000;

/** The tile-grid fields `lockedTemperatureAt` needs beyond the equirect
 * `width`/`height` addressing. */
export type LockedTemperatureSource = Pick<TilesScene, "width" | "height" | "elevation_m" | "sea_level_m">;

/** The tile lattice's per-index (lat, lon) center, degrees — the inverse of
 * `windows/scene/src/lib.rs`'s forward pixel-center mapping (`latitude =
 * 90 - (py+0.5)/height*180`, `longitude = (px+0.5)/width*360 - 180`). */
function tileLatLon(width: number, height: number, i: number): { lat: number; lon: number } {
  const row = Math.floor(i / width);
  const col = i % width;
  const lat = 90 - ((row + 0.5) / height) * 180;
  const lon = ((col + 0.5) / width) * 360 - 180;
  return { lat, lon };
}

/** Unit vector for a (lat, lon) in degrees — same convention as
 * `./views/globe.ts`'s `latLonToUnit` (the kernel's `GeoCoord`: `latitude =
 * asin(z)`, `longitude = atan2(y, x)`). */
function latLonToUnit(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/** The locked-world surface temperature (°C) from the substellar cosine, the
 * insolation `scale` (S^0.25), and the lapse cooling — mirrors
 * `locked_cell_temperature` (`domains/climate/src/substellar.rs`). */
function lockedCellTemperature(cosTheta: number, scale: number, lapse: number): number {
  if (cosTheta > 0) {
    return -18 + 78 * Math.pow(cosTheta, 0.3) * scale - lapse;
  }
  return -60 - lapse;
}

/** Temperature at tile `i` on absolute standard `day` for a tidally-locked
 * world, °C: the substellar hot spot librates in latitude ±`obliquityDeg`
 * over the year (`domains/climate/src/temperature.rs`'s `RotationRegime::
 * Locked` branch of `temperature_at`), and the tile's temperature is set by
 * its angular distance from that moving point. `insolation` is the world's
 * top-of-atmosphere insolation relative to Earth (`hornvale_astronomy::
 * insolation_rel` — `star.luminosityRel / orbitAu²`; §Task 7 brief). */
export function lockedTemperatureAt(
  tiles: LockedTemperatureSource,
  i: number,
  day: number,
  seasonPeriodDays: number,
  obliquityDeg: number,
  yearPhaseOffset: number,
  insolation: number,
): number {
  const { lat, lon } = tileLatLon(tiles.width, tiles.height, i);
  const p = latLonToUnit(lat, lon);
  const subLat = obliquityDeg * Math.sin(TAU * frac(day / seasonPeriodDays + yearPhaseOffset));
  const subLatRad = (subLat * Math.PI) / 180;
  const dir: [number, number, number] = [Math.cos(subLatRad), 0, Math.sin(subLatRad)];
  const cosTheta = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
  const scale = Math.pow(Math.max(insolation, 0), 0.25);
  const above = Math.max(0, tiles.elevation_m[i]! - tiles.sea_level_m);
  const lapse = LAPSE_C_PER_M * above;
  return lockedCellTemperature(cosTheta, scale, lapse);
}

/** World-level context `seasonalTemperatureAt` threads to whichever
 * evaluator a tile's regime needs. */
export interface SeasonalContext {
  yearPhaseOffset: number;
  obliquityDeg: number;
  insolation: number;
  /** The world's day length, in standard days — `null` for a tidally locked
   * world (no rotation to swing a diurnal cycle over, so `lensTemperatureAt`
   * never reads it in that branch). Threaded from `WorldElem.dayLengthDays`
   * (`../sim/scene`) via `systemSeasonalContext`. */
  dayLengthStd: number | null;
  /** Task 6's "watch a day": when set, overrides `day` for the *season*
   * component only (the year-phase term both `seasonalTemperatureAt` and
   * `lensTemperatureAt`'s declination compute) — the diurnal pulse's own
   * `dayFraction` keeps reading the live `day` unconditionally, so the
   * seasonal baseline holds still while the diurnal cycle keeps running.
   * `undefined` in the ordinary case: the season tracks the live clock day
   * like everything else. Mutated in place by `../views/globe.ts`'s
   * `setDayHold`, never read back out. */
  seasonDayOverride?: number;
}

/** Dispatching seasonal-temperature evaluator: locked worlds read the
 * librating-substellar reconstruction (`lockedTemperatureAt`); spinning
 * worlds read the mean+swing sinusoid (`temperatureAt`, ./climate) —
 * `temperatureAt` itself stays spinning-only so its signature never
 * entangles with locked worlds' world-level params. Honors
 * `ctx.seasonDayOverride` in place of `day` (Task 6's "watch a day" hold) —
 * see `SeasonalContext`'s doc comment. */
export function seasonalTemperatureAt(tiles: TilesScene, i: number, day: number, ctx: SeasonalContext): number {
  const seasonDay = ctx.seasonDayOverride ?? day;
  if (tiles.locked) {
    return lockedTemperatureAt(
      tiles,
      i,
      seasonDay,
      tiles.season_period_days,
      ctx.obliquityDeg,
      ctx.yearPhaseOffset,
      ctx.insolation,
    );
  }
  return temperatureAt(tiles, i, seasonDay, ctx.yearPhaseOffset);
}

/** The temperature lens' per-tile evaluator (`../views/lens.ts`):
 * `seasonalTemperatureAt`'s mean+seasonal baseline plus the diurnal (day/
 * night) pulse — `tDiurnalAmpC[i] * diurnalWaveform(lat_i, obliquityDeg,
 * yearPhase, dayFraction, dayLengthStd)` — for spinning worlds only.
 * Mirrors the producer's `RotationRegime::Spinning` branch of
 * `temperature_at` (`domains/climate/src/temperature.rs`), which computes
 * `year_phase` and `day_fraction` from the same absolute `day` the seasonal
 * term uses (no per-tile longitude term — the producer's diurnal model is a
 * planet-synchronized pulse, gated per tile only by latitude/declination).
 * Locked worlds (and any world with no day length) get no diurnal term at
 * all — the producer's `Locked` branch never reads `diurnal_amp`. Extracted
 * as its own pure function so the lens' afternoon-hotter-than-dawn behavior
 * is unit-testable without WebGL. */
export function lensTemperatureAt(tiles: TilesScene, i: number, day: number, ctx: SeasonalContext): number {
  const base = seasonalTemperatureAt(tiles, i, day, ctx);
  if (tiles.locked || ctx.dayLengthStd == null || tiles.season_period_days <= 0) return base;
  const seasonDay = ctx.seasonDayOverride ?? day;
  const yearPhase = frac(seasonDay / tiles.season_period_days + ctx.yearPhaseOffset);
  const dayFraction = frac(day);
  const { lat } = tileLatLon(tiles.width, tiles.height, i);
  return base + tiles.tDiurnalAmpC[i]! * diurnalWaveform(lat, ctx.obliquityDeg, yearPhase, dayFraction, ctx.dayLengthStd);
}

/** Derives `SeasonalContext` from a parsed `scene/system/v1` document — the
 * one place callers with a `SystemScene` in hand build the object
 * `seasonalTemperatureAt`/`iceFraction` need. `insolation` is
 * `hornvale_astronomy::insolation_rel`: top-of-atmosphere insolation
 * relative to Earth, `star.luminosityRel / orbitAu²` (both fields already
 * parsed by `./scene`; confirmed against the producer golden in
 * `lockedClimate.test.ts`, §Task 7 brief). */
export function systemSeasonalContext(sys: SystemScene): SeasonalContext {
  return {
    yearPhaseOffset: sys.world.yearPhaseOffset,
    obliquityDeg: sys.world.obliquityDeg,
    insolation: sys.star.luminosityRel / (sys.world.orbitAu * sys.world.orbitAu),
    dayLengthStd: sys.world.dayLengthDays,
  };
}
