/** Pure position/phase evaluator: reproduces the Rust calendar's phases from `SystemScene` elements. */

import type { SystemScene } from './scene';

const frac = (x: number) => x - Math.floor(x);

/** The world's orbital phase in [0,1): 0 at the genesis reference. */
export function worldPhase(sys: SystemScene, t: number): number {
  return frac(t / sys.world.yearDays + sys.world.yearPhaseOffset);
}

/** Synodic month of moon `i` (days), or null if it never laps the sun. */
export function synodicDays(sys: SystemScene, i: number): number | null {
  const p = sys.moons[i]!.siderealDays, y = sys.world.yearDays;
  return p >= y ? null : (p * y) / (y - p);
}

/** Moon `i`'s illumination phase in [0,1): 0 new, 0.5 full. */
export function moonPhase(sys: SystemScene, i: number, t: number): number {
  const syn = synodicDays(sys, i);
  if (syn === null) return 0;
  return frac(t / syn + sys.moons[i]!.phaseOffset);
}

/** The world's rotation phase in [0,1); 0 for a tidally locked world. */
export function rotationPhase(sys: SystemScene, t: number): number {
  const d = sys.world.dayLengthDays;
  return d === null ? 0 : frac(t / d);
}
