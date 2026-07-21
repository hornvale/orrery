/** Channel quantization step — the pixel-art banding used by the DATA-LESS
 * fallback path only (real worlds resolve a curated palette below). */
export const PIXEL_STEP = 32;

const quant = (c: number): number => Math.min(255, Math.round(c / PIXEL_STEP) * PIXEL_STEP);

/** Ocean is depth-toned (two flat blues), keyed by the tile's own elevation vs
 * sea level — a hard, unlit coastline with a legible deep/shallow read, the
 * reference-map look. */
const OCEAN_DEEP: readonly [number, number, number] = [26, 66, 132];
const OCEAN_SHALLOW: readonly [number, number, number] = [58, 138, 200];
/** How far below sea level (m) a tile must be to read as "deep". Visual-tuned.
 * Exported so `overworld.ts` (The Overworld) can reuse the exact deep/shallow
 * split instead of re-tuning a second threshold. */
export const OCEAN_DEEP_THRESHOLD_M = 1200;

/** River base colour (The Freshwater): a flowing blue, distinct from both
 * ocean tones (brighter/more saturated cyan than `OCEAN_SHALLOW`) so a river
 * reads as a live thread over land rather than a lake or coastline. Exported
 * for reuse by the globe's major-water overlay (`lens.ts`'s
 * `majorWaterColor`) so both rungs agree on "what a river looks like". */
export const RIVER_BASE: readonly [number, number, number] = [46, 134, 222];
/** Still-water lake tone for `salt-basin` nodes (The Freshwater): a muted
 * teal, deliberately neither the river blue nor either ocean shade. Exported
 * for reuse by the globe's major-water overlay, same rationale as
 * `RIVER_BASE`. */
export const LAKE_TONE: readonly [number, number, number] = [72, 150, 138];
/** `drainage` value at which a river reaches its brightest/widest-reading
 * intensity — a big river brighter than a creek. Visual-tuned. */
const RIVER_DRAINAGE_SATURATION = 5.0;
/** How much brighter (0-1 channel fraction toward white) a river at full
 * drainage saturation reads versus a bare trickle. Visual-tuned. */
const RIVER_DRAINAGE_LIGHTEN = 0.12;

/** Curated FLAT pixel-art land palette, keyed by `biomeLegend` name. Distinct
 * from the photoreal biome palette: saturated, reference-map colours, and —
 * critically — ice/alpine are NOT near-white (unlit, a near-white biome reads
 * as a blown-out blob), so every biome stays legible on a flat globe. Names
 * are hornvale's kebab-case `Biome::name`. Visual-pass-tuned. */
export const PIXEL_LAND_RGB: Readonly<Record<string, readonly [number, number, number]>> = {
  ice: [206, 230, 242], // light cyan, deliberately not white
  tundra: [160, 172, 138],
  taiga: [46, 110, 74], // richer boreal green
  'temperate-grassland': [126, 196, 84], // brighter meadow
  shrubland: [186, 174, 96],
  'temperate-forest': [56, 140, 66], // punchy forest green
  'temperate-rainforest': [34, 120, 66],
  desert: [238, 208, 120], // brighter sand
  savanna: [214, 188, 88],
  'tropical-seasonal-forest': [112, 182, 70],
  'tropical-rainforest': [28, 132, 60], // vivid jungle
  alpine: [172, 166, 154], // warm grey — distinct from ice
};

/** The curated flat pixel-art colour for tile/region node `idx` of `src`
 * (biome/ocean datum), 0–255. Reused by the globe base (retired) and the
 * flat map rung. */
export function pixelColorFor(
  rgb: readonly [number, number, number],
  src: {
    ocean?: boolean[];
    elevation_m?: number[];
    sea_level_m?: number;
    biome?: number[];
    biomeLegend?: string[];
    /** Inland water class per node, indexing `waterLegend` (The Freshwater). */
    water?: number[];
    /** The inland-water catalog `water` indexes into. */
    waterLegend?: string[];
    /** Flow magnitude per node, keying river intensity (The Freshwater). */
    drainage?: number[];
  },
  idx: number,
): [number, number, number] {
  const waterClass = src.water?.[idx];
  if (waterClass !== undefined && src.waterLegend) {
    const riverIndex = src.waterLegend.indexOf('river');
    if (riverIndex >= 0 && waterClass === riverIndex) {
      const drainage = src.drainage?.[idx] ?? 0;
      const t = Math.min(1, Math.max(0, drainage) / RIVER_DRAINAGE_SATURATION);
      const lighten = t * RIVER_DRAINAGE_LIGHTEN;
      return [
        Math.round(RIVER_BASE[0] + (255 - RIVER_BASE[0]) * lighten),
        Math.round(RIVER_BASE[1] + (255 - RIVER_BASE[1]) * lighten),
        Math.round(RIVER_BASE[2] + (255 - RIVER_BASE[2]) * lighten),
      ];
    }
    const saltBasinIndex = src.waterLegend.indexOf('salt-basin');
    if (saltBasinIndex >= 0 && waterClass === saltBasinIndex) {
      return [LAKE_TONE[0], LAKE_TONE[1], LAKE_TONE[2]];
    }
  }
  if (src.ocean?.[idx]) {
    const deep = (src.elevation_m?.[idx] ?? 0) < (src.sea_level_m ?? 0) - OCEAN_DEEP_THRESHOLD_M;
    const c = deep ? OCEAN_DEEP : OCEAN_SHALLOW;
    return [c[0], c[1], c[2]];
  }
  const name = src.biomeLegend?.[src.biome?.[idx] ?? -1];
  const land = name ? PIXEL_LAND_RGB[name] : undefined;
  if (land) return [land[0], land[1], land[2]];
  // Fallback: no biome data (unit fixtures) — quantize the lens hue.
  return [quant(rgb[0]), quant(rgb[1]), quant(rgb[2])];
}
