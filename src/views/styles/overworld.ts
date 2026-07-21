/** The flat "map" rung's procedural 16-bit-RPG-style overworld texture
 * (campaign "The Overworld"): a higher-resolution replacement for
 * `mapTexture.ts`'s one-flat-color-per-node `regionPixelTexture`. This task
 * establishes the pipeline and a palette fill only — every output pixel
 * takes its NEAREST region node's class (ocean depth, inland water, or
 * biome) and colors it from `OVERWORLD_PALETTE`. Later tasks in this
 * campaign layer within-biome dithering (Task 2), crafted coastlines (Task
 * 3), and outlines (Task 4) on top of this same fill — none of those change
 * which class a node resolves to, only how it's painted, so the class
 * resolution below mirrors `pixelBase.ts`'s `pixelColorFor` exactly (same
 * priority: inland water, then ocean depth, then biome name) rather than
 * inventing a second read of the same data. The pixel math
 * (`overworldRGBA`) is split from the `THREE.DataTexture` wrapper
 * (`overworldTexture`, in `mapTexture.ts`), same split as
 * `regionPixelRGBA`/`regionPixelTexture` and `./moonTexture.ts`, so it is
 * unit-testable without constructing a three.js texture. Pure — no
 * `Math.random`; determinism is a hard constraint (same region + dim always
 * paints the same bytes). */
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

/** Resolve region node `idx`'s overworld tone. Mirrors `pixelColorFor`'s
 * class-resolution priority exactly (inland water class, then ocean depth,
 * then biome name) so this renderer never disagrees with the flat pixel map
 * about WHICH class a node is — only how it's painted. */
function toneForNode(region: RegionScene, idx: number): RGB {
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
  if (region.ocean?.[idx]) {
    const deep = (region.elevation_m?.[idx] ?? 0) < (region.sea_level_m ?? 0) - OCEAN_DEEP_THRESHOLD_M;
    return deep ? OVERWORLD_PALETTE.ocean.deep : OVERWORLD_PALETTE.ocean.shallow;
  }
  const name = region.biomeLegend?.[region.biome?.[idx] ?? -1];
  const tone = name ? OVERWORLD_PALETTE.biome[name] : undefined;
  return tone ? tone.light : OVERWORLD_UNKNOWN;
}

/** RGBA bytes (4 per output texel, row-major, length `dim*dim*4`) for
 * `region`, rendered at `dim x dim`: each output pixel takes its NEAREST
 * region node's class/tone (palette fill only — no dither/coast/outline
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
      const [r, g, b] = toneForNode(region, rowBase + nodeCol);
      const o = (py * dim + px) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}
