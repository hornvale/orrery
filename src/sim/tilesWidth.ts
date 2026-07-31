/** How wide to request the `scene/tiles/v1` export.
 *
 * Since The Cascade the globe's surface comes from region patches, so this
 * export no longer carries surface detail — it carries what a region patch
 * cannot (spec §5): cloud type, ocean currents, settlement features, and the
 * width/height the locked-temperature evaluator needs. At that job a coarser
 * grid is enough, and the export is ~4x cheaper.
 *
 * A tidally-locked world is the exception: `regionsEnabled` excludes it (the
 * locked lens needs width/height a patch lacks), so its globe is still built
 * from this export and it keeps the full width. */
export const TILES_WIDTH_OVERLAY = 256;
export const TILES_WIDTH_LOCKED = 512;

export function tilesWidthFor(world: { dayLengthDays: number | null }): number {
  return world.dayLengthDays === null ? TILES_WIDTH_LOCKED : TILES_WIDTH_OVERLAY;
}
