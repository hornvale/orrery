/** Client-side seasonal ice from scene/tiles/v1 temperature layers — the
 * derivation documented (non-normatively) in the book's tiles reference.
 * Presentation only; the sim has no cryosphere (decision 0022). */
import type { TilesScene } from '../sim/scene';
import type { SeasonalContext } from '../sim/lockedClimate';
import { seasonalTemperatureAt } from '../sim/lockedClimate';

/** Default seasonal context for callers with no system scene in hand — see
 * `../views/lens.ts`'s `NO_SYSTEM_CONTEXT` (same rationale: a spinning tiles
 * document ignores `obliquityDeg`/`insolation` entirely). */
const NO_SYSTEM_CONTEXT: SeasonalContext = { yearPhaseOffset: 0, obliquityDeg: 0, insolation: 1, dayLengthStd: null };

/** Frozen fraction [0,1] at tile `i` on `day`: 1 below freeze, 0 above, a
 * soft 2°C ramp so the ice edge isn't a hard line. Client derivation
 * (decision 0022) — the sim has no cryosphere. `ctx` threads through to
 * `seasonalTemperatureAt` (`systemSeasonalContext(sys)`,
 * ../sim/lockedClimate); defaults to `NO_SYSTEM_CONTEXT` for callers with no
 * system scene in hand. */
export function iceFraction(
  tiles: TilesScene,
  i: number,
  day: number,
  ctx: SeasonalContext = NO_SYSTEM_CONTEXT,
  freezeC = 0,
): number {
  const t = seasonalTemperatureAt(tiles, i, day, ctx);
  const ramp = 2;
  if (t <= freezeC - ramp) return 1;
  if (t >= freezeC) return 0;
  return (freezeC - t) / ramp;
}
