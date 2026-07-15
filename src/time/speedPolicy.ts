/** Per-rung playback policy: a watchable rate at one altitude is a blur at
 * another (the globe spins once per day; ~1 mo/s is ~30 revolutions per
 * second there). Speeds are `SPEED_STEPS` mults — sim-seconds per real
 * second. */
import type { ZoomTarget } from '../views/zoom';

/** One rung's default and cap (null = uncapped). */
export interface RungPolicy { defaultMult: number; maxMult: number | null }

/** System keeps the shipped year-in-~12s, snapped to its nearest real step
 * (`~1 mo/s`) so the HUD highlight is honest from boot; the globe gets one
 * rotation in ~24 s and never offers the blur rates. */
export const SPEED_POLICY: Record<ZoomTarget, RungPolicy> = {
  system: { defaultMult: 2.6e6, maxMult: null },
  globe: { defaultMult: 3600, maxMult: 86400 },
};

/** `mult` clamped to `view`'s cap. */
export function clampMult(view: ZoomTarget, mult: number): number {
  const max = SPEED_POLICY[view].maxMult;
  return max === null ? mult : Math.min(mult, max);
}

/** Remembers the user's last speed choice per rung; restores it (clamped)
 * or the rung default. Session-local — deliberately not URL state. */
export class SpeedMemory {
  private last = new Map<ZoomTarget, number>();

  remember(view: ZoomTarget, mult: number): void {
    this.last.set(view, clampMult(view, mult));
  }

  restore(view: ZoomTarget): number {
    return clampMult(view, this.last.get(view) ?? SPEED_POLICY[view].defaultMult);
  }
}
