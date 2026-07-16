/** A lens is a pure projection of a tile's state onto a color.
 *
 * The realistic view is not a privileged ground truth that data modes
 * decorate — it is itself a colorizer (`ocean ? elevationColor :
 * biomeColorForName`), so it registers here as the `natural` lens and gets no
 * special case. Each lens owns its colormap, legend, and caption, so the HUD
 * stays generic over the registry and a new lens costs one file.
 *
 * Colormaps are presentation only (decision 0022): the sim ships numbers and
 * has no palette. Each `caption` says what its lens exaggerates or invents. */
import type { TilesScene } from '../sim/scene';
import { elevationColor } from '../sim/palette';
import { biomeColorForName } from './biomePalette';
import { HEX, sequential, diverging } from './colormap';
import { temperatureAt } from '../sim/climate';
import { PLATE_BOUNDARY, PLATE_SLOTS, colorPlates, isBoundaryTile } from './plateColoring';

/** 0-255 RGB, matching `elevationColor`'s existing return shape. */
export type RGB = [number, number, number];

/** One row of a lens's legend: a swatch and what it means. */
export interface LegendEntry {
  swatch: RGB;
  label: string;
}

/** A registered render mode. */
export interface Lens {
  /** Stable id — used by the HUD and the URL state. */
  id: string;
  /** HUD picker text. */
  label: string;
  /** What this lens exaggerates or invents (the caption discipline). */
  caption: string;
  /** Whether `colorAt` varies with `day`. Static lenses bake once at geometry
   * build; only a living lens pays the per-day recolor. */
  dependsOnDay: boolean;
  /** This lens's color for tile `i` on absolute standard `day`. */
  colorAt(tiles: TilesScene, i: number, day: number): RGB;
  /** The legend rows to draw for this lens. */
  legend(tiles: TilesScene): LegendEntry[];
}

/** Today's view, unchanged: ocean tiles shaded by depth, land by biome. */
export const naturalLens: Lens = {
  id: 'natural',
  label: 'natural',
  caption:
    'ocean shaded by depth, land by biome — a rendering choice, not a photograph: the sim ships numbers, not colors.',
  dependsOnDay: false,
  colorAt(tiles, i) {
    return tiles.ocean[i]
      ? elevationColor(tiles.elevation_m[i]!, tiles.sea_level_m)
      : biomeColorForName(tiles.biomeLegend[tiles.biome[i]!] ?? '');
  },
  legend(tiles) {
    const rows: LegendEntry[] = [
      { swatch: elevationColor(tiles.sea_level_m - 6000, tiles.sea_level_m), label: 'deep ocean' },
      { swatch: elevationColor(tiles.sea_level_m - 100, tiles.sea_level_m), label: 'shallows' },
    ];
    // One row per land biome actually present, in legend order.
    const present = new Set(tiles.biome.filter((_, i) => !tiles.ocean[i]));
    for (let b = 0; b < tiles.biomeLegend.length; b++) {
      if (!present.has(b)) continue;
      const name = tiles.biomeLegend[b]!;
      rows.push({ swatch: biomeColorForName(name), label: name });
    }
    return rows;
  },
};

/** Spec §7's validated ramps. Do not substitute or extend by eye — these were
 * validated with the dataviz validator against the orrery's surface (#05070f). */
const TEMP_COLD = HEX('#2a78d6');
const TEMP_MID = HEX('#f0efec');
const TEMP_HOT = HEX('#e34948');
/** Temperature's clamp, °C. Beyond ±30 the poles saturate.
 *
 * Was ±40 — a habitable world's surface sits mostly within −20…+35 °C, so a
 * ±40 clamp parked nearly every tile near the pale midpoint `#f0efec`. Worse,
 * the globe's directional light *multiplies* vertex colors (it tints as well
 * as dims), so that near-white midpoint under seed 42's warm G-class star
 * (`starTint` ≈ `#ffd678`) rendered tan — a globe that read as "no data" even
 * though the field was live. The clamp exists to bound outliers, not to span
 * the theoretical range, so ±30 is tighter to the values the field actually
 * takes. The palette endpoints themselves (`TEMP_COLD`/`TEMP_MID`/`TEMP_HOT`)
 * are unchanged — this is a rescale of the domain, not a repaint. */
const TEMP_EXTENT = 30;
const MOISTURE_RAMP: RGB[] = [HEX('#cde2fb'), HEX('#0d366b')];
const UNREST_RAMP: RGB[] = [HEX('#d4f0e4'), HEX('#0a4a33')];

/** Elevation everywhere through the hypsometric ramp — the atlas raster's own
 * convention, applied to land and sea alike rather than only under the sea. */
export const topographicLens: Lens = {
  id: 'topographic',
  label: 'topographic',
  caption: 'elevation through the atlas hypsometric ramp, relative to sea level; colors are a cartographic convention, not the ground’s actual hue.',
  dependsOnDay: false,
  colorAt: (tiles, i) => elevationColor(tiles.elevation_m[i]!, tiles.sea_level_m),
  legend: (tiles) => [
    { swatch: elevationColor(tiles.sea_level_m - 6000, tiles.sea_level_m), label: 'abyss' },
    { swatch: elevationColor(tiles.sea_level_m, tiles.sea_level_m), label: 'sea level' },
    { swatch: elevationColor(tiles.sea_level_m + 2500, tiles.sea_level_m), label: '2.5 km' },
    { swatch: elevationColor(tiles.sea_level_m + 5000, tiles.sea_level_m), label: '5 km +' },
  ],
};

/** The one living lens: temperature advances with the sim clock through the
 * producer-pinned seasonal evaluator. Diverges about 0 °C — freezing is the
 * meaningful midpoint, and the one the ice overlay keys on. */
export const temperatureLens: Lens = {
  id: 'temperature',
  label: 'temperature',
  caption: `surface temperature on the shown day, diverging about freezing and clamped at ±${TEMP_EXTENT} °C; the seasonal curve is the producer’s own evaluator, not a client invention.`,
  dependsOnDay: true,
  colorAt: (tiles, i, day) =>
    diverging(TEMP_COLD, TEMP_MID, TEMP_HOT, temperatureAt(tiles, i, day), TEMP_EXTENT),
  legend: () => [
    { swatch: TEMP_COLD, label: `≤ −${TEMP_EXTENT} °C` },
    { swatch: TEMP_MID, label: '0 °C' },
    { swatch: TEMP_HOT, label: `≥ +${TEMP_EXTENT} °C` },
  ],
};

/** Moisture as the climate model's own dimensionless index — deliberately NOT
 * rainfall: no mm/yr calibration exists and inventing one would be invented
 * precision. */
export const moistureLens: Lens = {
  id: 'moisture',
  label: 'moisture',
  caption: 'the climate model’s dimensionless moisture index (0-1) — not rainfall: no mm/yr calibration exists, and inventing one would be invented precision.',
  dependsOnDay: false,
  colorAt: (tiles, i) => sequential(MOISTURE_RAMP, tiles.moisture[i]!),
  legend: () => [
    { swatch: MOISTURE_RAMP[0]!, label: '0 — dry' },
    { swatch: MOISTURE_RAMP[1]!, label: '1 — wet' },
  ],
};

/** Tectonic unrest, dimensionless in [0,1].
 *
 * The producer's terrain model card declares this field *derived* (geometry
 * and rule tables, not simulation) and *approximated*: a static present-day
 * snapshot, classified from instantaneous plate motion rather than an
 * accumulated stress history. The caption says so — a lens that renders an
 * approximated field as a bare fact is exactly what the caption discipline
 * exists to prevent. */
export const unrestLens: Lens = {
  id: 'unrest',
  label: 'unrest',
  caption:
    'tectonic unrest, dimensionless (0-1) — highest along young convergent boundaries, near zero in old interiors. A static present-day snapshot read off plate geometry, not a simulation of seismicity: it is classified from instantaneous motion, with no accumulated stress history and no deep time.',
  dependsOnDay: false,
  colorAt: (tiles, i) => sequential(UNREST_RAMP, tiles.unrest[i]!),
  legend: () => [
    { swatch: UNREST_RAMP[0]!, label: '0 — quiet' },
    { swatch: UNREST_RAMP[1]!, label: '1 — violent' },
  ],
};

const plateColorCache = new WeakMap<TilesScene, Map<number, number>>();
function platesFor(tiles: TilesScene): Map<number, number> {
  let c = plateColorCache.get(tiles);
  if (!c) {
    c = colorPlates(tiles);
    plateColorCache.set(tiles, c);
  }
  return c;
}

/** Plates as a map coloring: adjacent plates always differ, boundaries inked.
 * The colors carry separation, not identity — a plate's id is an arbitrary
 * label, so "plate 7 is blue" means nothing across worlds. */
export const plateLens: Lens = {
  id: 'plate',
  label: 'plates',
  caption:
    'tectonic plates, colored so neighbours differ — the colors are a map coloring, not identities: a plate’s id is an arbitrary label and carries no order or meaning across worlds.',
  dependsOnDay: false,
  colorAt: (tiles, i) => {
    if (isBoundaryTile(tiles, i)) return PLATE_BOUNDARY;
    const slot = platesFor(tiles).get(tiles.plate[i]!) ?? 0;
    return PLATE_SLOTS[slot]!;
  },
  legend: (tiles) => {
    const used = new Set(platesFor(tiles).values());
    return [
      ...[...used].sort((a, b) => a - b).map((slot) => ({ swatch: PLATE_SLOTS[slot]!, label: '' })),
      { swatch: PLATE_BOUNDARY, label: 'plate boundary' },
    ];
  },
};

/** The registry. `natural` is first — it is the default, not a base case. */
export const LENSES: readonly Lens[] = [
  naturalLens,
  topographicLens,
  temperatureLens,
  moistureLens,
  unrestLens,
  plateLens,
];

/** The lens for `id`, falling back to `natural` for anything unrecognized
 * (a stale URL, a removed lens). */
export function lensById(id: string): Lens {
  return LENSES.find((l) => l.id === id) ?? naturalLens;
}
