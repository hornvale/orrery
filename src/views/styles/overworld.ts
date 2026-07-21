/** The flat "map" rung's procedural 16-bit-RPG-style overworld texture
 * (campaign "The Overworld"): a higher-resolution replacement for
 * `mapTexture.ts`'s one-flat-color-per-node `regionPixelTexture`. Task 1
 * established the pipeline and a palette fill: every output pixel takes its
 * NEAREST region node's class (ocean depth, inland water, or biome) from
 * `OVERWORLD_PALETTE`. Task 2 (this task) adds within-biome/within-ocean
 * ordered (Bayer) dithering — a land or ocean pixel now alternates between
 * its class's `light`/`dark` tone pair by a fixed 4x4 threshold matrix
 * (`BAYER_4`), biased by the node's elevation relative to sea level so the
 * dither also reads as coarse relief shading (higher land leans `light`;
 * ocean elevation is always at or below sea level, so shallower water only
 * reaches a neutral 50/50 split, never a `light`-leaning bias beyond
 * neutral). Task 3 (this task) adds crafted coastlines: at the land/ocean
 * boundary, a land pixel with an ocean neighbor within 1px takes a flat
 * `outline` tone, and an ocean pixel within `COAST_BAND_PX` of land takes
 * the flat `shallows` tone (its innermost `FOAM_BAND_PX` dithering between
 * `foam`/`shallows` instead) rather than the open-ocean depth dither —
 * these coastline tones WIN over the base fill/dither wherever they apply.
 * Task 4 (this task) adds INTERNAL biome-boundary outlines: a land pixel
 * whose nearest node's biome differs from a land neighbor's within 1px
 * (`hasBiomeBoundaryWithin1`, gated by `OVERWORLD_OUTLINE_BIOME`) also takes
 * the flat `outline` tone — the "drawn map" tell of a line between two
 * adjacent biomes, not just at the shore. It reuses Task 3's `oceanMask`
 * purely to exclude water neighbors (a land/water edge is Task 3's outline,
 * never this one — biome is only ever compared between two LAND pixels) and
 * is checked after the coastline outline, so the coastline still wins at
 * the coast (moot in practice since both paint the same `outline` tone).
 * None of these tasks change which class a node resolves to, only how it's
 * painted, so the class resolution below mirrors `pixelBase.ts`'s
 * `pixelColorFor` exactly (same priority: inland water, then ocean depth,
 * then biome name) rather than inventing a second read of the same data.
 * River/lake/outline tones are flat (not dithered); shallows is flat except
 * within `FOAM_BAND_PX`, where it alternates with foam. The pixel
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

/** The water band nearest a coastline (Task 3, crafted coastlines) — a
 * lighter, warmer blue than open ocean so a shore reads as shallow water
 * before it reads as land. Also half of the foam dither's tone pair (see
 * `OVERWORLD_FOAM`). Visual-tuned. */
const OVERWORLD_SHALLOWS: RGB = [110, 190, 220];
/** The bright foam dither's other tone, painted (mixed with `shallows` via
 * `BAYER_4`, see `foamOrShallowsTone`) on the water pixels immediately
 * outside the coast outline (Task 3). Visual-tuned. */
const OVERWORLD_FOAM: RGB = [232, 244, 250];

/** The land-side coastline silhouette (Task 3, crafted coastlines): a dark
 * flat tone painted on a land pixel that has an ocean neighbor within 1
 * output pixel, turning the land/water boundary into a crafted shore edge
 * instead of a hard palette-fill seam. Reserved for Task 4's biome-boundary
 * outlines too (same tone, a different boundary condition). Visual-tuned. */
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

/** Width, in output pixels, of the shallows band on the water side of a
 * coastline (Task 3, crafted coastlines) — a water pixel within this
 * Chebyshev distance of a land pixel paints `OVERWORLD_PALETTE.shallows`
 * (or the foam dither, within `FOAM_BAND_PX`) instead of the open-ocean
 * depth dither. Visual-tuned; Task 5 is the tuning/perf pass if this reads
 * too wide or narrow at `OVERWORLD_TEXTURE_DIM`. */
export const COAST_BAND_PX = 3;

/** Width, in output pixels, of the foam sub-band nearest the coast outline
 * (a subset of `COAST_BAND_PX`, `FOAM_BAND_PX <= COAST_BAND_PX`) — a water
 * pixel within this Chebyshev distance of land dithers between
 * `OVERWORLD_PALETTE.foam` and `OVERWORLD_PALETTE.shallows` (see
 * `foamOrShallowsTone`) rather than painting a solid foam tone, so the surf
 * line reads as textured, not a flat ring. Visual-tuned. */
export const FOAM_BAND_PX = 1;

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
 * sea level, `OCEAN_DEEP_THRESHOLD_M`) so both use the same "higher/shallower
 * leans light, lower/deeper leans dark" formula — but only land can reach a
 * positive bias (elevation above the reference); ocean nodes are always at
 * or below sea level, so the ocean bias is always `<= 0` and shallow water
 * reaches at most a neutral 50/50 split, never a `light`-leaning bias. */
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

/** This output pixel's nearest region node index, given `dim` and the
 * region's own `samples` node grid — the same nearest-node resolution
 * `overworldRGBA`'s pixel loop and the coastline mask both need, so it's a
 * single shared function rather than two copies of the same arithmetic. */
function nodeIndexFor(region: RegionScene, dim: number, px: number, py: number): number {
  const nodesPerSide = region.samples + 1;
  const nodeRow = Math.min(region.samples, Math.floor((py / dim) * nodesPerSide));
  const nodeCol = Math.min(region.samples, Math.floor((px / dim) * nodesPerSide));
  return nodeRow * nodesPerSide + nodeCol;
}

/** Whether output pixel `(px, py)` has ANY ocean neighbor within a
 * Chebyshev distance of 1 (the 8 surrounding pixels), per `oceanMask` (see
 * `overworldRGBA`). Out-of-range neighbors (the texture's own edge) are
 * skipped, not treated as water — a coastline needs an actual water pixel
 * on the other side. Used only for LAND pixels (the coast outline is the
 * land-side silhouette; see this module's doc comment). */
function hasOceanNeighborWithin1(oceanMask: Uint8Array, dim: number, px: number, py: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;
      if (oceanMask[ny * dim + nx] === 1) return true;
    }
  }
  return false;
}

/** Gate for the internal biome-boundary outline (Task 4) — the thin
 * `outline` line painted where two adjacent LAND pixels resolve to
 * different biomes, distinct from Task 3's land/water coastline outline
 * (always on). Default `true`; exists so the campaign's mandatory visual
 * pass (Task 5) can dial the "drawn map" tell off or re-tune it without
 * touching the coastline logic. */
export const OVERWORLD_OUTLINE_BIOME = true;

/** This LAND output pixel's nearest node's resolved biome NAME (via
 * `biomeLegend`), or `undefined` if it isn't resolvable to a biome (ocean,
 * inland water, or a node with no biome datum) — used only to COMPARE two
 * land pixels for the biome-boundary outline, never to pick a paint tone
 * (that's `toneForNode`'s job). Comparing the resolved NAME rather than the
 * raw `region.biome` index matters: two distinct legend indices can name the
 * same biome, and since `toneForNode` paints by name, an index-only compare
 * could draw a boundary line between two pixels that render identically —
 * the opposite of the "drawn map" tell this task adds. An unresolvable
 * neighbor just can't trigger a boundary rather than being coerced to some
 * sentinel value. */
function biomeNameFor(region: RegionScene, idx: number): string | undefined {
  return region.biomeLegend?.[region.biome?.[idx] ?? -1];
}

/** Whether output pixel `(px, py)` — already known to be LAND — sits on an
 * internal biome/biome boundary: some neighbor within a Chebyshev distance
 * of 1 is ALSO land (per `oceanMask`) but resolves to a different biome
 * name. Land/water boundaries are Task 3's outline, not this one, so a
 * water neighbor is skipped entirely here — comparing biome only ever
 * happens between two land pixels, the same land/land-only guard the task
 * brief calls for. Out-of-range neighbors (the texture's own edge) are
 * skipped, matching `hasOceanNeighborWithin1`. */
function hasBiomeBoundaryWithin1(
  region: RegionScene,
  nodeIdx: Int32Array,
  oceanMask: Uint8Array,
  dim: number,
  px: number,
  py: number,
): boolean {
  const ownBiome = biomeNameFor(region, nodeIdx[py * dim + px]!);
  if (ownBiome === undefined) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) continue;
      const ni = ny * dim + nx;
      if (oceanMask[ni] === 1) continue; // land/water is Task 3's outline, not this one
      const neighborBiome = biomeNameFor(region, nodeIdx[ni]!);
      if (neighborBiome !== undefined && neighborBiome !== ownBiome) return true;
    }
  }
  return false;
}

/** The Chebyshev distance (in output pixels) from a WATER pixel `(px, py)`
 * to the nearest LAND pixel, checked ring-by-ring out to `maxK`, or
 * `undefined` if no land lies within `maxK`. Each ring `k` is only the
 * perimeter of the `2k+1`-wide box (not the whole box) since any land
 * closer than `k` would already have been found at a smaller ring — this
 * keeps the search bounded (`O(maxK)` rings, `O(k)` cells per ring) rather
 * than rechecking the same interior cells at every radius. Out-of-range
 * neighbors are skipped (the texture edge is neither land nor water here).
 */
function nearestLandDistance(
  oceanMask: Uint8Array,
  dim: number,
  px: number,
  py: number,
  maxK: number,
): number | undefined {
  const isLandAt = (x: number, y: number): boolean => {
    if (x < 0 || x >= dim || y < 0 || y >= dim) return false;
    return oceanMask[y * dim + x] === 0;
  };
  for (let k = 1; k <= maxK; k++) {
    for (let dx = -k; dx <= k; dx++) {
      if (isLandAt(px + dx, py - k) || isLandAt(px + dx, py + k)) return k;
    }
    for (let dy = -k + 1; dy <= k - 1; dy++) {
      if (isLandAt(px - k, py + dy) || isLandAt(px + k, py + dy)) return k;
    }
  }
  return undefined;
}

/** The foam dither at output pixel `(px, py)`: alternates between
 * `OVERWORLD_PALETTE.foam` and `OVERWORLD_PALETTE.shallows` by the same
 * `BAYER_4` ordered matrix Task 2's within-biome dithering uses (at a
 * neutral, unbiased 0.5 threshold — foam has no elevation/relief concept to
 * bias toward), so the surf line reads as a textured band rather than a
 * flat, solid ring. */
function foamOrShallowsTone(px: number, py: number): RGB {
  const n = BAYER_4.length;
  const bayerValue = BAYER_4[py % n]![px % n]!;
  return bayerValue < 0.5 ? OVERWORLD_PALETTE.foam : OVERWORLD_PALETTE.shallows;
}

/** RGBA bytes (4 per output texel, row-major, length `dim*dim*4`) for
 * `region`, rendered at `dim x dim`: each output pixel takes its NEAREST
 * region node's class, dithered between that class's `light`/`dark` tone
 * pair by the Bayer matrix and the node's elevation (Task 2), with a
 * crafted coastline (Task 3) layered on top at the land/ocean boundary: a
 * land pixel with an ocean neighbor within 1px takes the flat `outline`
 * tone (the land-side silhouette); an ocean pixel within `COAST_BAND_PX` of
 * land takes the flat `shallows` tone instead of the open-ocean depth
 * dither, and the innermost `FOAM_BAND_PX` of that band dithers between
 * `foam`/`shallows` instead. The coastline classification (land vs ocean)
 * is the node's own `ocean` field only — inland water (river/lake) is
 * unaffected, matching Task 2's scope note. Coastline tones WIN over the
 * base fill/dither on the pixels they touch (composition order: coastline
 * over dither). Row-major top-down (row 0 = region gy=0), matching
 * `regionPixelRGBA`'s convention so `overworldTexture` can flip the same
 * way (`flipY:true`) to agree with the symbol overlay. Pure — no GPU, no
 * randomness; identical `(region, dim)` always produces identical bytes. */
export function overworldRGBA(region: RegionScene, dim: number): Uint8Array {
  const out = new Uint8Array(dim * dim * 4);

  // Pass 1: precompute each output pixel's nearest node and ocean/land
  // classification once, up front — the coastline pass needs to look up
  // NEIGHBORING pixels' classification regardless of raster order, so it
  // can't be folded into a single row-major pass over `out`.
  const nodeIdx = new Int32Array(dim * dim);
  const oceanMask = new Uint8Array(dim * dim);
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      const i = py * dim + px;
      const idx = nodeIndexFor(region, dim, px, py);
      nodeIdx[i] = idx;
      oceanMask[i] = region.ocean?.[idx] ? 1 : 0;
    }
  }

  // Pass 2: paint. A land pixel touching ocean gets the outline; an ocean
  // pixel near land gets the shallows/foam coastline band instead of its
  // ordinary depth dither; everything else keeps Task 1/2's palette fill.
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      const i = py * dim + px;
      const idx = nodeIdx[i]!;
      let tone: RGB;
      if (oceanMask[i] === 1) {
        const landDistance = nearestLandDistance(oceanMask, dim, px, py, COAST_BAND_PX);
        if (landDistance !== undefined && landDistance <= FOAM_BAND_PX) {
          tone = foamOrShallowsTone(px, py);
        } else if (landDistance !== undefined) {
          tone = OVERWORLD_PALETTE.shallows;
        } else {
          tone = toneForNode(region, idx, px, py);
        }
      } else if (hasOceanNeighborWithin1(oceanMask, dim, px, py)) {
        tone = OVERWORLD_PALETTE.outline;
      } else if (OVERWORLD_OUTLINE_BIOME && hasBiomeBoundaryWithin1(region, nodeIdx, oceanMask, dim, px, py)) {
        tone = OVERWORLD_PALETTE.outline;
      } else {
        tone = toneForNode(region, idx, px, py);
      }
      const [r, g, b] = tone;
      const o = i * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}
