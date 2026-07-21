/** Discrete level-of-detail rungs, coarsest to finest. */
export type Rung = 'far' | 'mid' | 'near';

/** Per-rung symbol budget and visibility thresholds. */
export interface RungBudget {
  /** Max number of peak symbols to show at this rung. */
  peaks: number;
  /** Max number of forest symbols to show at this rung. */
  forests: number;
  /** Minimum elevation (m) a peak must have to be eligible at this rung. */
  peakMinElevationM: number;
  /** Minimum area a forest patch must have to be eligible at this rung. */
  forestMinArea: number;
  /** Tile-grid stride between candidate ocean wave-marks at this rung (bigger
   * = sparser scatter). */
  waveStride: number;
  /** Max number of wave-mark symbols to show at this rung. */
  waves: number;
}

// Visual-pass-tuned. Thresholds fall and budgets rise as we zoom in, so finer
// features emerge. Angular radius (rad) of the visible cap drives the rung.
export const RUNG_BUDGETS: Record<Rung, RungBudget> = {
  far: { peaks: 12, forests: 8, peakMinElevationM: 3000, forestMinArea: 60, waveStride: 14, waves: 40 },
  mid: { peaks: 40, forests: 30, peakMinElevationM: 1500, forestMinArea: 15, waveStride: 10, waves: 90 },
  near: { peaks: 120, forests: 90, peakMinElevationM: 500, forestMinArea: 3, waveStride: 7, waves: 160 },
};

/** Coarser rung when more of the sphere is visible. Boundaries visual-tuned. */
export function rungForZoom(visibleAngularRadiusRad: number): Rung {
  if (visibleAngularRadiusRad > 0.8) return 'far';
  if (visibleAngularRadiusRad > 0.25) return 'mid';
  return 'near';
}

/** Items arrive pre-sorted by salience (Task 2); take the first `budget`. */
export function selectByBudget<T>(items: T[], budget: number): T[] {
  return items.slice(0, Math.max(0, budget));
}
