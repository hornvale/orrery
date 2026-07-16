/** Parses and validates the two committed scene documents the orrery reads. */

/** The `scene/system/v1` star element (`windows/scene`'s `StarElem`). */
export interface StarElem {
  className: string;
  luminosityRel: number;
  hzInnerAu: number;
  hzOuterAu: number;
}

/** The `scene/system/v1` world element (`windows/scene`'s `WorldElem`). */
export interface WorldElem {
  orbitAu: number;
  yearDays: number;
  /** Absent (`null`) when the world is tidally locked and has no day length. */
  dayLengthDays: number | null;
  obliquityDeg: number;
  yearPhaseOffset: number;
}

/** The `scene/system/v1` moon element (`windows/scene`'s `MoonElem`). */
export interface MoonElem {
  siderealDays: number;
  phaseOffset: number;
  distanceMm: number;
  sizeRel: number;
}

/** One `scene/system/v1` document: the orrery's orbital elements. */
export interface SystemScene {
  schema: string;
  seed: number;
  star: StarElem;
  world: WorldElem;
  moons: MoonElem[];
}

/** A named point on the `scene/tiles/v1` lattice (`windows/scene`'s
 * `Feature`) — settlements today, the flagship last under its own kind. */
export interface Feature {
  name: string;
  kind: string;
  latitude: number;
  longitude: number;
}

/** The fields of a `scene/tiles/v1` document the orrery's globe needs.
 * `elevation_m`/`sea_level_m` keep the wire's snake_case names because
 * `sampleTile` (./views/globe.ts) indexes the per-tile arrays generically by
 * that literal key; `biomeLegend`/`features` are read by property, not by
 * generic key, so those camelCase like the system-scene elements do. */
export interface TilesScene {
  schema: string;
  width: number;
  height: number;
  sea_level_m: number;
  elevation_m: number[];
  /** Whether each tile is ocean (sea level baked in) — row-major, matching `elevation_m`. */
  ocean: boolean[];
  /** Biome per tile, as an index into `biomeLegend` — row-major, matching `elevation_m`. */
  biome: number[];
  /** The full biome catalog, in stable order; `biome`'s indices key into this by position. */
  biomeLegend: string[];
  /** Tectonic plate id per tile — an arbitrary per-world label, not a
   * quantity: ids carry no ordering and no cross-world meaning. Row-major,
   * matching `elevation_m`. */
  plate: number[];
  /** Tectonic unrest per tile, dimensionless in [0, 1] — row-major, matching
   * `elevation_m`. */
  unrest: number[];
  /** Named points: settlements, the flagship last. */
  features: Feature[];
  /** Mean temperature per tile, degrees Celsius — row-major, matching `elevation_m`. */
  t_mean_c: number[];
  /** Seasonal temperature swing (peak-to-mean amplitude) per tile, degrees Celsius — row-major, matching `elevation_m`. */
  t_swing_c: number[];
  /** The length of one seasonal cycle, in standard days. */
  season_period_days: number;
  /** The world's count of atmospheric circulation bands; `null` when the world is tidally locked and has none. */
  circulationBands: number | null;
  /** Moisture per tile, a dimensionless ratio — row-major, matching `elevation_m`. */
  moisture: number[];
}

/** The fields of a `scene/tiles-region/v1` document — a regional tile
 * lattice at higher on-tile sample density, addressed by a single quad-tree
 * node (`face`/`level`/`ix`/`iy`) subdivided into `samples` x `samples`
 * cells. Per-node arrays keep their wire snake_case names, same rationale
 * as `TilesScene`; the two document-level catalog fields
 * (`circulation_bands`/`biome_legend`) camelCase identically. */
export interface RegionScene {
  schema: string;
  seed: number;
  face: number;
  level: number;
  ix: number;
  iy: number;
  samples: number;
  sea_level_m: number;
  /** The length of one seasonal cycle, in standard days. */
  season_period_days: number;
  /** The world's count of atmospheric circulation bands; `null` when the world is tidally locked and has none. */
  circulationBands: number | null;
  /** The full biome catalog, in stable order; `biome`'s indices key into this by position. */
  biomeLegend: string[];
  /** Elevation per node, meters — length `(samples+1)^2`. */
  elevation_m: number[];
  /** Whether each node is ocean (sea level baked in) — length `(samples+1)^2`. */
  ocean: boolean[];
  /** Biome per node, as an index into `biomeLegend` — length `(samples+1)^2`. */
  biome: number[];
  /** Tectonic plate id per node — length `(samples+1)^2`. */
  plate: number[];
  /** Tectonic unrest per node — length `(samples+1)^2`. */
  unrest: number[];
  /** Mean temperature per node, degrees Celsius — length `(samples+1)^2`. */
  t_mean_c: number[];
  /** Seasonal temperature swing (peak-to-mean amplitude) per node, degrees Celsius — length `(samples+1)^2`. */
  t_swing_c: number[];
  /** Moisture per node, a dimensionless ratio — length `(samples+1)^2`. */
  moisture: number[];
}

/** A scene document violated the contract; the message names how. */
export class SceneFormatError extends Error {}

const SYSTEM_SCHEMA = "scene/system/v1";
const TILES_SCHEMA = "scene/tiles/v1";
const REGION_SCHEMA = "scene/tiles-region/v1";

function fail(message: string): never {
  throw new SceneFormatError(message);
}

function parseDocument(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    fail(`not JSON: ${e}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    fail("document must be a JSON object");
  }
  return doc as Record<string, unknown>;
}

function requireNumber(doc: Record<string, unknown>, key: string): number {
  const value = doc[key];
  if (typeof value !== "number") fail(`${key} must be a number`);
  return value;
}

function requireString(doc: Record<string, unknown>, key: string): string {
  const value = doc[key];
  if (typeof value !== "string") fail(`${key} must be a string`);
  return value;
}

function parseStar(doc: unknown): StarElem {
  const star = doc as Record<string, unknown>;
  if (typeof star !== "object" || star === null) fail("star must be an object");
  return {
    className: requireString(star, "class_name"),
    luminosityRel: requireNumber(star, "luminosity_rel"),
    hzInnerAu: requireNumber(star, "hz_inner_au"),
    hzOuterAu: requireNumber(star, "hz_outer_au"),
  };
}

function parseWorld(doc: unknown): WorldElem {
  const world = doc as Record<string, unknown>;
  if (typeof world !== "object" || world === null) fail("world must be an object");
  const dayLengthDays = world.day_length_days;
  if (dayLengthDays !== undefined && dayLengthDays !== null && typeof dayLengthDays !== "number") {
    fail("day_length_days must be a number or absent");
  }
  return {
    orbitAu: requireNumber(world, "orbit_au"),
    yearDays: requireNumber(world, "year_days"),
    dayLengthDays: dayLengthDays === undefined ? null : dayLengthDays,
    obliquityDeg: requireNumber(world, "obliquity_deg"),
    yearPhaseOffset: requireNumber(world, "year_phase_offset"),
  };
}

function parseMoon(doc: unknown): MoonElem {
  const moon = doc as Record<string, unknown>;
  if (typeof moon !== "object" || moon === null) fail("moon must be an object");
  return {
    siderealDays: requireNumber(moon, "sidereal_days"),
    phaseOffset: requireNumber(moon, "phase_offset"),
    distanceMm: requireNumber(moon, "distance_mm"),
    sizeRel: requireNumber(moon, "size_rel"),
  };
}

/** Parse and validate a scene/system/v1 document; throw SceneFormatError naming any violation. */
export function parseSystem(text: string): SystemScene {
  const doc = parseDocument(text);
  if (doc.schema !== SYSTEM_SCHEMA) {
    fail(`schema must be ${SYSTEM_SCHEMA}, got ${String(doc.schema)}`);
  }
  const seed = requireNumber(doc, "seed");
  const star = parseStar(doc.star);
  const world = parseWorld(doc.world);
  const moons = doc.moons;
  if (!Array.isArray(moons)) fail("moons must be an array");
  return {
    schema: SYSTEM_SCHEMA,
    seed,
    star,
    world,
    moons: moons.map(parseMoon),
  };
}

function numberArray(doc: Record<string, unknown>, key: string, length: number): number[] {
  const value = doc[key];
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${key} must be an array of ${length} numbers`);
  }
  for (const v of value) if (typeof v !== "number") fail(`${key} holds a non-number`);
  return value as number[];
}

function booleanArray(doc: Record<string, unknown>, key: string, length: number): boolean[] {
  const value = doc[key];
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${key} must be an array of ${length} booleans`);
  }
  for (const v of value) if (typeof v !== "boolean") fail(`${key} holds a non-boolean`);
  return value as boolean[];
}

function stringArray(doc: Record<string, unknown>, key: string): string[] {
  const value = doc[key];
  if (!Array.isArray(value)) fail(`${key} must be an array`);
  for (const v of value) if (typeof v !== "string") fail(`${key} holds a non-string`);
  return value as string[];
}

function parseFeature(doc: unknown): Feature {
  const feature = doc as Record<string, unknown>;
  if (typeof feature !== "object" || feature === null) fail("a feature must be an object");
  return {
    name: requireString(feature, "name"),
    kind: requireString(feature, "kind"),
    latitude: requireNumber(feature, "latitude"),
    longitude: requireNumber(feature, "longitude"),
  };
}

/** Parse and validate a scene/tiles/v1 document; throw SceneFormatError naming any violation. */
export function parseTiles(text: string): TilesScene {
  const doc = parseDocument(text);
  if (doc.schema !== TILES_SCHEMA) {
    fail(`schema must be ${TILES_SCHEMA}, got ${String(doc.schema)}`);
  }
  const width = doc.width;
  const height = doc.height;
  if (
    typeof width !== "number" || typeof height !== "number" || height * 2 !== width ||
    !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0
  ) {
    fail(`height must be width / 2, got ${String(width)}×${String(height)}`);
  }
  const seaLevelM = requireNumber(doc, "sea_level_m");
  const tiles = width * height;
  const features = doc.features;
  if (!Array.isArray(features)) fail("features must be an array");
  const seasonPeriodDays = requireNumber(doc, "season_period_days");
  if (seasonPeriodDays <= 0) fail("season_period_days must be positive");
  const circulationBandsRaw = doc.circulation_bands;
  let circulationBands: number | null;
  if (circulationBandsRaw === undefined || circulationBandsRaw === null) {
    circulationBands = null;
  } else if (
    typeof circulationBandsRaw !== "number" ||
    !Number.isInteger(circulationBandsRaw) ||
    circulationBandsRaw < 1
  ) {
    fail("circulation_bands must be an integer >= 1, or absent");
  } else {
    circulationBands = circulationBandsRaw;
  }
  return {
    schema: TILES_SCHEMA,
    width,
    height,
    sea_level_m: seaLevelM,
    elevation_m: numberArray(doc, "elevation_m", tiles),
    ocean: booleanArray(doc, "ocean", tiles),
    biome: numberArray(doc, "biome", tiles),
    biomeLegend: stringArray(doc, "biome_legend"),
    plate: numberArray(doc, "plate", tiles),
    unrest: numberArray(doc, "unrest", tiles),
    features: features.map(parseFeature),
    t_mean_c: numberArray(doc, "t_mean_c", tiles),
    t_swing_c: numberArray(doc, "t_swing_c", tiles),
    season_period_days: seasonPeriodDays,
    circulationBands,
    moisture: numberArray(doc, "moisture", tiles),
  };
}

/** Parse and validate a scene/tiles-region/v1 document; throw SceneFormatError naming any violation. */
export function parseRegion(text: string): RegionScene {
  const doc = parseDocument(text);
  if (doc.schema !== REGION_SCHEMA) {
    fail(`schema must be ${REGION_SCHEMA}, got ${String(doc.schema)}`);
  }
  const seed = requireNumber(doc, "seed");
  const face = requireNumber(doc, "face");
  const level = requireNumber(doc, "level");
  const ix = requireNumber(doc, "ix");
  const iy = requireNumber(doc, "iy");
  const samples = doc.samples;
  if (typeof samples !== "number" || !Number.isInteger(samples) || samples <= 0) {
    fail("samples must be a positive integer");
  }
  const seaLevelM = requireNumber(doc, "sea_level_m");
  const seasonPeriodDays = requireNumber(doc, "season_period_days");
  if (seasonPeriodDays <= 0) fail("season_period_days must be positive");
  const circulationBandsRaw = doc.circulation_bands;
  let circulationBands: number | null;
  if (circulationBandsRaw === undefined || circulationBandsRaw === null) {
    circulationBands = null;
  } else if (
    typeof circulationBandsRaw !== "number" ||
    !Number.isInteger(circulationBandsRaw) ||
    circulationBandsRaw < 1
  ) {
    fail("circulation_bands must be an integer >= 1, or absent");
  } else {
    circulationBands = circulationBandsRaw;
  }
  const nodes = (samples + 1) * (samples + 1);
  return {
    schema: REGION_SCHEMA,
    seed,
    face,
    level,
    ix,
    iy,
    samples,
    sea_level_m: seaLevelM,
    season_period_days: seasonPeriodDays,
    circulationBands,
    biomeLegend: stringArray(doc, "biome_legend"),
    elevation_m: numberArray(doc, "elevation_m", nodes),
    ocean: booleanArray(doc, "ocean", nodes),
    biome: numberArray(doc, "biome", nodes),
    plate: numberArray(doc, "plate", nodes),
    unrest: numberArray(doc, "unrest", nodes),
    t_mean_c: numberArray(doc, "t_mean_c", nodes),
    t_swing_c: numberArray(doc, "t_swing_c", nodes),
    moisture: numberArray(doc, "moisture", nodes),
  };
}
