/** Schematic-vs-true scale for the system view (ORRERY-scale-honesty).
 * "True" means: DISTANCES are true to the documents (`distanceMm` through
 * the same AU scale as the orbit); body RADII use reference conventions —
 * Earth's radius for the world (the `REFERENCE_RADIUS_M` convention the
 * globe already uses), Sol's for the star, Luna's × `sizeRel` for moons —
 * because the scene documents carry no absolute radii, and the render
 * admits the lies it cannot retract. At true scale the bodies all but
 * vanish against the orbit's sweep: that is the lesson, and the helm's
 * camera is what makes it explorable. */

/** Megameters per astronomical unit. */
export const MM_PER_AU = 149598;
/** World units per AU — must match system.ts's AU_SCALE. */
const AU_SCALE = 3;
/** Reference radii, megameters: Earth, Sol, Luna. */
const EARTH_RADIUS_MM = 6.371;
const SOL_RADIUS_MM = 696;
const LUNA_RADIUS_MM = 1.7375;
/** Schematic constants — mirror system.ts. */
const STAR_RADIUS = 0.35;
const WORLD_RADIUS = 0.12;
const MOON_RADIUS = 0.045;
const MOON_RUNG_BASE = 0.32;
const MOON_RUNG_STEP = 0.22;

const mmToUnits = (mm: number) => (mm / MM_PER_AU) * AU_SCALE;

/** Moon `i`'s orbit radius (world units): even ladder, or true distance. */
export function moonOrbitRadiusUnits(i: number, distanceMm: number, trueScale: boolean): number {
  return trueScale ? mmToUnits(distanceMm) : MOON_RUNG_BASE + i * MOON_RUNG_STEP;
}

/** World sphere radius (world units). */
export function worldRadiusUnits(trueScale: boolean): number {
  return trueScale ? mmToUnits(EARTH_RADIUS_MM) : WORLD_RADIUS;
}

/** Star sphere radius (world units). */
export function starRadiusUnits(trueScale: boolean): number {
  return trueScale ? mmToUnits(SOL_RADIUS_MM) : STAR_RADIUS;
}

/** Moon sphere radius (world units); schematic keeps the size clamp. */
export function moonRadiusUnits(sizeRel: number, trueScale: boolean): number {
  if (trueScale) return mmToUnits(LUNA_RADIUS_MM) * sizeRel;
  return MOON_RADIUS * Math.max(0.3, Math.min(2, sizeRel));
}
