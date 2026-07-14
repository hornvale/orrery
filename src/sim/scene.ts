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

/** The fields of a `scene/tiles/v1` document the orrery's globe needs. */
export interface TilesScene {
  schema: string;
  width: number;
  height: number;
  sea_level_m: number;
  elevation_m: number[];
}

/** A scene document violated the contract; the message names how. */
export class SceneFormatError extends Error {}

const SYSTEM_SCHEMA = "scene/system/v1";
const TILES_SCHEMA = "scene/tiles/v1";

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
  return {
    schema: TILES_SCHEMA,
    width,
    height,
    sea_level_m: seaLevelM,
    elevation_m: numberArray(doc, "elevation_m", tiles),
  };
}
