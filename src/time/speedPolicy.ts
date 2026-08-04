/** Per-rung playback policy: a watchable rate at one altitude is a blur at
 * another (the globe spins once per day; ~1 mo/s is ~30 revolutions per
 * second there). Speeds are `SPEED_STEPS` mults — sim-seconds per real
 * second. */
import type { ZoomTarget } from '../views/zoom';

/** The offered playback rates, as sim-seconds per real second. Time policy,
 * not chrome: the control registry turns each step into a `rate` option, and
 * `SPEED_POLICY` below caps which of them a rung will accept. */
export const SPEED_STEPS: Array<{ label: string; mult: number }> = [
  { label: '1×', mult: 1 },
  { label: '1 min/s', mult: 60 },
  { label: '1 hr/s', mult: 3600 },
  { label: '1 day/s', mult: 86400 },
  { label: '10 d/s', mult: 864000 },
  { label: '~1 mo/s', mult: 2.6e6 },
];

/** One rung's default and cap (null = uncapped). */
export interface RungPolicy { defaultMult: number; maxMult: number | null }

/** System keeps the shipped year-in-~12s, snapped to its nearest real step
 * (`~1 mo/s`) so the HUD highlight is honest from boot; the globe defaults
 * to 1 hr/s but now offers the fast rates too (10 d/s, ~1 mo/s) — the
 * diurnal-spin freeze is what makes them watchable rather than a blur. */
export const SPEED_POLICY: Record<ZoomTarget, RungPolicy> = {
  system: { defaultMult: 2.6e6, maxMult: null },
  globe: { defaultMult: 3600, maxMult: 2.6e6 },
  // TODO(map-rung): Task 4 wires the real map view; stub with the globe's
  // policy for now so ZoomTarget stays total.
  map: { defaultMult: 3600, maxMult: 2.6e6 },
};

/** `mult` clamped to `view`'s cap. */
export function clampMult(view: ZoomTarget, mult: number): number {
  const max = SPEED_POLICY[view].maxMult;
  return max === null ? mult : Math.min(mult, max);
}

/** Watch-a-day ("day-hold") and the fast seasonal-hold regime are mutually
 * exclusive: day-hold pins the season so the diurnal pulse reads at a
 * watchable pace, but a `mult` above `seasonalHoldMult` lets the day keep
 * racing anyway while the season sits frozen, aliasing the pulse into noise.
 * Called wherever the active mult changes; when day-hold is on and `mult`
 * crosses into the fast regime, runs `setDayHold(false)` /
 * `setDayHoldActive(false)` and returns the disengaged state. A no-op
 * (returns `dayHoldOn` unchanged, no calls) when day-hold is already off or
 * `mult` stays in the watchable regime. */
export function reconcileDayHold(
  dayHoldOn: boolean,
  mult: number,
  seasonalHoldMult: number,
  setDayHold: (on: boolean) => void,
  setDayHoldActive: (on: boolean) => void,
): boolean {
  if (dayHoldOn && mult > seasonalHoldMult) {
    setDayHold(false);
    setDayHoldActive(false);
    return false;
  }
  return dayHoldOn;
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
