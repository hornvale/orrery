/** Inspector content: every card is assembled ONLY from the scene documents
 * plus the already-golden derivations (ephemeris phases, tile sampling) —
 * surfacing the latent numbers behind the pixels, never computing new
 * physics (ORRERY-ephemeris-inspector). */
import type { EclipseEvent, Feature, MoonsScene, SystemScene, TilesScene } from '../sim/scene';
import { moonPhase, synodicDays } from '../sim/ephemeris';
import { illuminatedFraction } from '../sim/moon';
import { sampleTile } from '../views/worldMesh';
import { dayToRawDate, formatRawDate } from '../time/calendar';

/** One info card: a title, a kind line, and preformatted body lines. */
export interface InfoCard { title: string; kindLine: string; lines: string[] }

/** What a named scene object resolves to for inspection. */
export type Target =
  | { kind: 'star' }
  | { kind: 'world' }
  | { kind: 'moon'; index: number }
  | { kind: 'feature'; name: string };

/** Map a THREE object name to an inspectable target — the raycast walks
 * ancestors through this until something answers. */
export function namedTarget(name: string): Target | null {
  if (name === 'star') return { kind: 'star' };
  if (
    name === 'world' ||
    name === 'world-spin' ||
    name.startsWith('globe-face-') ||
    name.startsWith('globe-tile-')
  ) {
    return { kind: 'world' };
  }
  const moon = /^moon-(\d+)$/.exec(name);
  if (moon) return { kind: 'moon', index: Number(moon[1]) };
  if (name.startsWith('feature-')) return { kind: 'feature', name: name.slice('feature-'.length) };
  return null;
}

const fmtLat = (lat: number) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
const fmtLon = (lon: number) => `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

/** Standard Earth surface gravity, m/s² — the intuition anchor for a
 * moon's `surfaceGravityMs2` (`scene/moons/v1`), not a simulated quantity. */
const EARTH_G_MS2 = 9.81;

/** Days until moon `i` next reaches full (phase 0.5); null if it never
 * laps the sun (synodicDays' own null case). */
export function daysToNextFull(sys: SystemScene, i: number, day: number): number | null {
  const syn = synodicDays(sys, i);
  if (syn === null) return null;
  return ((0.5 - moonPhase(sys, i, day) + 1) % 1) * syn;
}

/** A settlement (or the flagship): position plus its own ground sample. */
export function settlementInfo(tiles: TilesScene, f: Feature): InfoCard {
  const elevation = sampleTile(tiles, f.latitude, f.longitude, 'elevation_m');
  const ocean = sampleTile(tiles, f.latitude, f.longitude, 'ocean');
  // elevation_m is datum-relative and the datum's zero is not sea level
  // (sea_level_m is far from 0 in real documents) — altitude above the sea
  // is the number a reader means, on land and under it alike.
  const altitude = elevation - tiles.sea_level_m;
  const ground = ocean
    ? `ocean · ${(-altitude).toFixed(0)} m deep`
    : `${tiles.biomeLegend[sampleTile(tiles, f.latitude, f.longitude, 'biome')] ?? 'unknown'} · ${altitude.toFixed(0)} m above sea`;
  return {
    title: f.name,
    kindLine: f.kind,
    lines: [`${fmtLat(f.latitude)} ${fmtLon(f.longitude)}`, ground],
  };
}

/** One marker site: every feature standing on the same exact coordinates
 * shares one card — they share the ground truth too (same tile sample), so
 * the card names every resident instead of pretending the click chose one.
 * `features[0]` (the marker group's namesake — the flagship when present)
 * titles the card. */
export function siteInfo(tiles: TilesScene, features: Feature[]): InfoCard {
  const first = features[0]!;
  const base = settlementInfo(tiles, first);
  if (features.length === 1) return base;
  const others = features.slice(1);
  return {
    title: base.title,
    kindLine:
      first.kind === 'flagship'
        ? `flagship + ${others.length} settlement${others.length === 1 ? '' : 's'}`
        : `${features.length} settlements`,
    lines: [...base.lines, `also here: ${others.map((f) => f.name).join(', ')}`],
  };
}

/** Moon `i` now: orbital elements, instantaneous illumination, and its
 * `scene/moons/v1` physical surface descriptors (mass, radius, gravity,
 * albedo, surface class). */
export function moonInfo(sys: SystemScene, moons: MoonsScene, i: number, day: number): InfoCard {
  const m = sys.moons[i]!;
  const surface = moons.moons[i]!;
  const lit = illuminatedFraction(moonPhase(sys, i, day));
  const full = daysToNextFull(sys, i, day);
  // An inclination past 90° sweeps the retrograde way once projected onto
  // the orbit plane (`moonLocalPosition`, ./views/system.ts) — the same
  // threshold flags it here.
  const retrograde = m.inclinationDeg > 90;
  return {
    title: `moon ${i + 1} of ${sys.moons.length}`,
    kindLine: `${retrograde ? 'retrograde ' : ''}${surface.surfaceClass} moon`,
    lines: [
      `sidereal period ${m.siderealDays.toFixed(2)} d`,
      `distance ${m.distanceMm.toFixed(0)} Mm · size ×${m.sizeRel.toFixed(2)}`,
      `mass ×${surface.massRel.toFixed(2)} luna · radius ${surface.radiusKm.toFixed(0)} km`,
      `surface gravity ${surface.surfaceGravityMs2.toFixed(2)} m/s² (×${(surface.surfaceGravityMs2 / EARTH_G_MS2).toFixed(2)} Earth g)`,
      `albedo ${surface.albedo.toFixed(2)}`,
      `formed by ${surface.formation} · density ${surface.densityGCm3.toFixed(2)} g/cm³`,
      `illuminated ${(lit * 100).toFixed(0)} %`,
      full === null ? 'never laps the sun (no synodic month)' : `full in ${full.toFixed(1)} d`,
    ],
  };
}

/** The star: class, luminosity, habitable zone. */
export function starInfo(sys: SystemScene): InfoCard {
  return {
    title: `class ${sys.star.className} star`,
    kindLine: 'star',
    lines: [
      `luminosity ×${sys.star.luminosityRel.toFixed(3)} (relative)`,
      `habitable zone ${sys.star.hzInnerAu.toFixed(2)}–${sys.star.hzOuterAu.toFixed(2)} AU`,
    ],
  };
}

/** A dated eclipse (`scene/eclipses/v1`): body, kind, the moon involved, and
 * the day it lands — the day scrubber's mark opens this card
 * (`eclipseMarkPositions`, ./eclipseMarks.ts, carries the click through). */
export function eclipseInfo(event: EclipseEvent): InfoCard {
  return {
    title: `${event.body} eclipse`,
    kindLine: `${event.kind} · moon ${event.moonIndex}`,
    lines: [`day ${event.day.toFixed(1)}`],
  };
}

/** The world: orbital elements plus the current raw date. */
export function worldInfo(sys: SystemScene, day: number): InfoCard {
  const w = sys.world;
  return {
    title: 'the world',
    kindLine: 'world',
    lines: [
      `orbit ${w.orbitAu.toFixed(3)} AU · year ${w.yearDays.toFixed(1)} d`,
      w.dayLengthDays === null ? 'tidally locked (no day)' : `day length ${w.dayLengthDays.toFixed(3)} d`,
      `obliquity ${w.obliquityDeg.toFixed(1)}°`,
      formatRawDate(dayToRawDate(day, w.yearDays)),
    ],
  };
}
