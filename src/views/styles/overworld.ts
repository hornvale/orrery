/** The flat "map" rung's procedural 16-bit-RPG-style overworld texture
 * (campaign "The Overworld"): a higher-resolution replacement for
 * `mapTexture.ts`'s one-flat-color-per-node `regionPixelTexture`. Task 1
 * established the pipeline and a palette fill: every output pixel takes its
 * NEAREST region node's class (ocean depth, inland water, or biome) from
 * `OVERWORLD_PALETTE`. Task 2 (this task) adds within-biome/within-ocean
 * ordered (Bayer) dithering — a land or ocean pixel now alternates between
 * its class's `light`/`dark` tone pair by a fixed 4x4 threshold matrix
 * (`BAYER_4`), biased by the node's elevation relative to sea level so the
 * dither also reads as coarse relief shading (higher land / shallower water
 * leans `light`). Later tasks (crafted coastlines, Task 3; biome-boundary
 * outlines, Task 4) layer on top of this same fill — none of those change
 * which class a node resolves to, only how it's painted, so the class
 * resolution below mirrors `pixelBase.ts`'s `pixelColorFor` exactly (same
 * priority: inland water, then ocean depth, then biome name) rather than
 * inventing a second read of the same data. River/lake/shallows/foam/outline
 * tones are NOT dithered (coastlines/outlines are later tasks). The pixel
 * math (`overworldRGBA`) is split from the `THREE.DataTexture` wrapper
 * (`overworldTexture`, in `mapTexture.ts`), same split as
 * `regionPixelRGBA`/`regionPixelTexture` and `./moonTexture.ts`, so it is
 * unit-testable without constructing a three.js texture. Pure — no
 * `Math.random`; determinism is a hard constraint (same region + dim always
 * paints the same bytes) — the dither is a fixed function of `(px, py)` and
 * the node's own fields, never wall-clock or random state. */
import type { RegionScene } from '../../sim/scene';
import { OCEAN_DEEP_THRESHOLD_M, PIXEL_LAND_RGB } from './pixelBase';

/** An opaque RGB tone, 0-255 per channel. */
type RGB = readonly [number, number, number];

/** The output texture's edge length, texels. Square, matching the region's
 * own square node grid. A first-pass value — the campaign's mandatory
 * visual pass (Task 5) is the tuning/perf step if this stalls interaction. */
export const OVERWORLD_TEXTURE_DIM = 384;

/** How much brighter/darker (per-channel multiplicative scale, an
 * approximation of a luma shift — not true HSL luma, kept boring/cheap since
 * this runs per output texel) the `light`/`dark` tone of a light/dark pair
 * reads versus the seed color from `PIXEL_LAND_RGB`. Visual-tuned; Task 2
 * (within-biome dithering) is what actually alternates between the two. */
const LIGHT_LUMA_SCALE = 1.12;
const DARK_LUMA_SCALE = 0.88;

/** Multiply `rgb`'s channels by `scale`, clamped to a valid byte. */
function scaleTone(rgb: RGB, scale: number): RGB {
  return [
    Math.min(255, Math.max(0, Math.round(rgb[0] * scale))),
    Math.min(255, Math.max(0, Math.round(rgb[1] * scale))),
    Math.min(255, Math.max(0, Math.round(rgb[2] * scale))),
  ];
}

/** Derive a `{ light, dark }` pair from one seed tone. */
function toneRange(rgb: RGB): { light: RGB; dark: RGB } {
  return { light: scaleTone(rgb, LIGHT_LUMA_SCALE), dark: scaleTone(rgb, DARK_LUMA_SCALE) };
}

/** Per-biome `{ light, dark }` tone pairs, keyed by `biomeLegend` name (the
 * same names `PIXEL_LAND_RGB` uses) — seeded from that curated flat palette
 * so the overworld and the original pixel-art map agree on each biome's
 * base hue, just rendered at a finer grain. */
const OVERWORLD_BIOME_PALETTE: Readonly<Record<string, { light: RGB; dark: RGB }>> = Object.fromEntries(
  Object.entries(PIXEL_LAND_RGB).map(([name, rgb]) => [name, toneRange(rgb)]),
);

/** Ocean depth-toned pair, keyed the same way `pixelBase.ts`'s
 * `OCEAN_DEEP`/`OCEAN_SHALLOW` are (deep vs shallow by `OCEAN_DEEP_THRESHOLD_M`)
 * but its own tones — the overworld's higher-res fill gets its own palette,
 * not a byte-for-byte copy of the flat map's. Visual-tuned. */
const OVERWORLD_OCEAN_SHALLOW: RGB = [64, 148, 208];
const OVERWORLD_OCEAN_DEEP: RGB = [22, 58, 120];

/** Inland-water tones (The Freshwater's `river`/`salt-basin` classes),
 * distinct from both ocean tones and every biome tone so a river or lake
 * still reads as water over land at this resolution. Visual-tuned. */
const OVERWORLD_RIVER: RGB = [58, 150, 224];
const OVERWORLD_LAKE: RGB = [70, 150, 150];

/** Fallback tone for a node with no resolvable biome (unit fixtures only —
 * real worlds always carry a biome datum for every land node). A neutral
 * gray, deliberately not matching any real biome/ocean/water tone. */
const OVERWORLD_UNKNOWN: RGB = [128, 128, 128];

/** Reserved for Task 3 (crafted coastlines): the water band nearest a
 * coastline, and the bright foam dither just outside the land/water
 * outline. Unused by this task's flat fill — defined now so the palette's
 * shape is stable across the campaign's tasks. Visual-tuned. */
const OVERWORLD_SHALLOWS: RGB = [110, 190, 220];
const OVERWORLD_FOAM: RGB = [232, 244, 250];

/** Reserved for Tasks 3/4 (land/water and biome-boundary outlines). Unused
 * by this task's flat fill. Visual-tuned. */
const OVERWORLD_OUTLINE: RGB = [18, 22, 26];

/** The overworld renderer's full palette: per-biome light/dark pairs plus
 * the water/coastline/outline tones every later task in this campaign draws
 * from. `biome` is keyed by `biomeLegend`/`PIXEL_LAND_RGB` name. */
export const OVERWORLD_PALETTE = {
  biome: OVERWORLD_BIOME_PALETTE,
  ocean: { shallow: OVERWORLD_OCEAN_SHALLOW, deep: OVERWORLD_OCEAN_DEEP },
  river: OVERWORLD_RIVER,
  lake: OVERWORLD_LAKE,
  shallows: OVERWORLD_SHALLOWS,
  foam: OVERWORLD_FOAM,
  outline: OVERWORLD_OUTLINE,
} as const;

/** Ordered (Bayer) dither threshold matrix, the classic 4x4 index matrix
 * normalized so each of its 16 cells owns a distinct, evenly-spaced
 * threshold in `[0, 1)` (`(rawIndex + 0.5) / 16`) — tiled across the output
 * texture: pixel `(px, py)`'s threshold is `BAYER_4[py % 4][px % 4]`. At a
 * neutral (unbiased) threshold of 0.5, exactly half of the 16 cells fall
 * below it and half at-or-above, so a uniform bias still paints BOTH tones
 * of a pair — the ordered-dither "base texture" — rather than a flat fill. */
const BAYER_4_RAW: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
export const BAYER_4: readonly (readonly number[])[] = BAYER_4_RAW.map((row) =>
  row.map((v) => (v + 0.5) / 16),
);

/** How strongly a node's elevation (relative to sea level) shifts the
 * dither's light/dark threshold away from neutral (0.5) — 0 would disable
 * the elevation bias entirely (a pure 50/50 Bayer texture); 1 lets an
 * elevation at or beyond its relief/depth scale (see `OVERWORLD_RELIEF_SCALE_M`,
 * `OCEAN_DEEP_THRESHOLD_M`) saturate the threshold to 0 or 1, painting a
 * single flat tone (matching the old hard ocean deep/shallow cutoff at the
 * threshold's boundary). Visual-tuned. */
export const OVERWORLD_DITHER_STRENGTH = 0.5;

/** Elevation delta (meters, above/below sea level) at which a LAND node's
 * dither bias reaches its full `OVERWORLD_DITHER_STRENGTH` swing toward the
 * `light` tone — a relief-reading knob, not a physical constant (real-world
 * mountain elevations run well past this, so land rarely fully saturates,
 * keeping the base dither texture visible even on high ground).
 * Visual-tuned. */
const OVERWORLD_RELIEF_SCALE_M = 2000;

/** This node's dither bias in `[-1, 1]`: how far `elevationM` sits above (+)
 * or below (-) `referenceM`, scaled by `scaleM` and clamped. Shared by land
 * (relative to sea level, `OVERWORLD_RELIEF_SCALE_M`) and ocean (relative to
 * sea level, `OCEAN_DEEP_THRESHOLD_M`) so both read "higher/shallower leans
 * light, lower/deeper leans dark" the same way. */
function elevationBias(elevationM: number, referenceM: number, scaleM: number): number {
  return Math.max(-1, Math.min(1, (elevationM - referenceM) / scaleM));
}

/** Pick `tones.light` or `tones.dark` for output pixel `(px, py)` given a
 * `bias` in `[-1, 1]` from `elevationBias` (positive biases toward `light`).
 * The Bayer threshold at this pixel is compared against a threshold shifted
 * by `bias * OVERWORLD_DITHER_STRENGTH` off its neutral 0.5 — `bias === 0`
 * reproduces the unbiased 50/50 dither texture; `bias === ±1` can saturate
 * to a single flat tone once the shifted threshold clears 0 or 1. */
function ditherTone(tones: { light: RGB; dark: RGB }, px: number, py: number, bias: number): RGB {
  const n = BAYER_4.length;
  const bayerValue = BAYER_4[py % n]![px % n]!;
  const threshold = Math.max(0, Math.min(1, 0.5 + OVERWORLD_DITHER_STRENGTH * bias));
  return bayerValue < threshold ? tones.light : tones.dark;
}

/** Resolve region node `idx`'s overworld tone at output pixel `(px, py)`.
 * Mirrors `pixelColorFor`'s class-resolution priority exactly (inland water
 * class, then ocean depth, then biome name) so this renderer never disagrees
 * with the flat pixel map about WHICH class a node is — only how it's
 * painted. Inland water (river/lake) stays a flat tone (no dither, matching
 * Task 2's scope — coastlines are Task 3); ocean and biome land both dither
 * between their tone pair's `light`/`dark`, biased by the node's elevation
 * relative to sea level. */
function toneForNode(region: RegionScene, idx: number, px: number, py: number): RGB {
  // Defensive optional chaining throughout, same rationale as
  // `pixelColorFor`: unit fixtures commonly cast a partial object through
  // `unknown` into `RegionScene`, so a field the interface marks required
  // can still be `undefined` at runtime.
  const waterClass = region.water?.[idx];
  if (waterClass !== undefined && region.waterLegend && region.waterLegend.length > 0) {
    const riverIndex = region.waterLegend.indexOf('river');
    if (riverIndex >= 0 && waterClass === riverIndex) return OVERWORLD_PALETTE.river;
    const saltBasinIndex = region.waterLegend.indexOf('salt-basin');
    if (saltBasinIndex >= 0 && waterClass === saltBasinIndex) return OVERWORLD_PALETTE.lake;
  }
  const seaLevel = region.sea_level_m ?? 0;
  const elevation = region.elevation_m?.[idx] ?? 0;
  if (region.ocean?.[idx]) {
    const bias = elevationBias(elevation, seaLevel, OCEAN_DEEP_THRESHOLD_M);
    return ditherTone(
      { light: OVERWORLD_PALETTE.ocean.shallow, dark: OVERWORLD_PALETTE.ocean.deep },
      px,
      py,
      bias,
    );
  }
  const name = region.biomeLegend?.[region.biome?.[idx] ?? -1];
  const tones = name ? OVERWORLD_PALETTE.biome[name] : undefined;
  if (!tones) return OVERWORLD_UNKNOWN;
  const bias = elevationBias(elevation, seaLevel, OVERWORLD_RELIEF_SCALE_M);
  return ditherTone(tones, px, py, bias);
}

/** RGBA bytes (4 per output texel, row-major, length `dim*dim*4`) for
 * `region`, rendered at `dim x dim`: each output pixel takes its NEAREST
 * region node's class, dithered between that class's `light`/`dark` tone
 * pair by the Bayer matrix and the node's elevation (no coastlines/outlines
 * yet, see this module's doc comment). Row-major top-down (row 0 = region
 * gy=0), matching `regionPixelRGBA`'s convention so `overworldTexture` can
 * flip the same way (`flipY:true`) to agree with the symbol overlay. Pure —
 * no GPU, no randomness; identical `(region, dim)` always produces
 * identical bytes. */
export function overworldRGBA(region: RegionScene, dim: number): Uint8Array {
  const nodesPerSide = region.samples + 1;
  const out = new Uint8Array(dim * dim * 4);
  for (let py = 0; py < dim; py++) {
    const nodeRow = Math.min(region.samples, Math.floor((py / dim) * nodesPerSide));
    const rowBase = nodeRow * nodesPerSide;
    for (let px = 0; px < dim; px++) {
      const nodeCol = Math.min(region.samples, Math.floor((px / dim) * nodesPerSide));
      const [r, g, b] = toneForNode(region, rowBase + nodeCol, px, py);
      const o = (py * dim + px) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}
