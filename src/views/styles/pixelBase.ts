import type { BaseTreatment } from '../renderStyle';
import type { TilesScene } from '../../sim/scene';

/** Channel quantization step — the pixel-art banding used by the DATA-LESS
 * fallback path only (real worlds resolve a curated palette below). */
export const PIXEL_STEP = 32;

const quant = (c: number): number => Math.min(255, Math.round(c / PIXEL_STEP) * PIXEL_STEP);

/** Ocean is depth-toned (two flat blues), keyed by the tile's own elevation vs
 * sea level — a hard, unlit coastline with a legible deep/shallow read, the
 * reference-map look. */
const OCEAN_DEEP: readonly [number, number, number] = [30, 60, 110];
const OCEAN_SHALLOW: readonly [number, number, number] = [58, 108, 168];
/** How far below sea level (m) a tile must be to read as "deep". Visual-tuned. */
const OCEAN_DEEP_THRESHOLD_M = 1200;

/** Curated FLAT pixel-art land palette, keyed by `biomeLegend` name. Distinct
 * from the photoreal biome palette: saturated, reference-map colours, and —
 * critically — ice/alpine are NOT near-white (unlit, a near-white biome reads
 * as a blown-out blob), so every biome stays legible on a flat globe. Names
 * are hornvale's kebab-case `Biome::name`. Visual-pass-tuned. */
const PIXEL_LAND_RGB: Readonly<Record<string, readonly [number, number, number]>> = {
  ice: [198, 222, 236], // light cyan, deliberately not white
  tundra: [150, 160, 140],
  taiga: [52, 92, 68],
  'temperate-grassland': [138, 178, 92],
  shrubland: [172, 162, 104],
  'temperate-forest': [70, 122, 64],
  'temperate-rainforest': [46, 104, 62],
  desert: [224, 198, 128],
  savanna: [200, 176, 96],
  'tropical-seasonal-forest': [112, 158, 72],
  'tropical-rainforest': [42, 112, 56],
  alpine: [156, 150, 142], // warm grey — distinct from ice
};

/** Data-native pixel base: colour comes from the tile's biome/ocean DATUM, not
 * the lit frame — so land can never take the ocean's colour, and (unlit) no
 * bright biome blows out to white. Ocean is depth-toned; land resolves a
 * curated flat palette by biome name. The quantized-lens path is a fallback
 * only for tiles with no biome data (e.g. headless unit fixtures). */
export const pixelBaseTreatment: BaseTreatment = {
  id: 'pixel',
  unlit: true,
  transform(rgb, src: TilesScene, idx) {
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
  },
};
