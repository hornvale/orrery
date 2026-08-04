/** A LOOK is how the world is drawn — one axis replacing the three the HUD
 * used to expose separately (`RenderStyle`, a post-process chain; `GlobeStyle`,
 * the globe mesh's geometry; `MapStyle`, the map rung's rendering). A viewer
 * has no way to tell those apart, so they are one choice here.
 *
 * Orthogonal to the data LENS (`./lens`), which chooses what data is coloured.
 * Colours and shading are presentation only (decision 0022).
 *
 * Only genuinely Look-specific settings belong in a Look. `waves`, `glint`,
 * `night fill` and the scale controls apply across several Looks, so they are
 * permanent control-registry entries, not Look-contributed ones. */
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { TilesScene } from '../sim/scene';
import type { GlobeStyle } from './globe';
import type { MapStyle } from './mapView';
import { pixelArtStyle } from './styles/pixelArt';
import type { Control } from '../ui/controls/kinds';
import type { DitherSettings } from './styles/dither3d';
import { DITHER_DEFAULTS } from './styles/dither3d';

export interface Look {
  /** Stable id — the URL codec writes it and the control registry keys on it. */
  id: string;
  label: string;
  /** Which worldMesh build path the globe's tiles use. */
  globeMesh: GlobeStyle;
  /** Which material the globe's surface wears. `dither` arrives in Stage 5;
   * until then every Look is `standard` and the globe ignores the field. */
  globeSurface: 'standard' | 'dither';
  /** How the map rung renders. */
  mapRung: MapStyle;
  /** Screen-space passes over the rendered globe frame. Empty for every Look
   * but `pixel` — the surface-level Looks do their work in the material. */
  postPasses(tiles: TilesScene): Pass[];
}

export const naturalLook: Look = {
  id: 'natural',
  label: 'natural',
  globeMesh: 'smooth',
  globeSurface: 'standard',
  mapRung: 'voxel',
  postPasses: () => [],
};

export const voxelLook: Look = {
  id: 'voxel',
  label: 'voxel',
  globeMesh: 'voxel',
  globeSurface: 'standard',
  mapRung: 'voxel',
  postPasses: () => [],
};

/** Surface-Stable Fractal Dithering. `globeSurface: 'dither'` is inert until
 * Stage 5 builds the material — the Look is registered now so the roster,
 * the URL codec and the picker are all settled before the shader lands. */
export const dither3dLook: Look = {
  id: 'dither3d',
  label: 'dither3d',
  globeMesh: 'smooth',
  globeSurface: 'dither',
  mapRung: 'voxel',
  postPasses: () => [],
};

export const pixelLook: Look = {
  id: 'pixel',
  label: 'pixel',
  globeMesh: 'smooth',
  globeSurface: 'standard',
  mapRung: 'pixel',
  postPasses: (tiles) => pixelArtStyle.passes(tiles),
};

export const LOOKS: readonly Look[] = [naturalLook, voxelLook, dither3dLook, pixelLook];

/** The Look with this id, or `natural` if none matches — a stale link from
 * before a Look was renamed opens the world rather than erroring. */
export function lookById(id: string): Look {
  return LOOKS.find((l) => l.id === id) ?? naturalLook;
}

/** The dither Look's own seven controls. Handed a sink so the Look module
 * stays free of any view handle — `main.ts` connects it to
 * `globeView.setDitherSettings`.
 *
 * Seven entries, and the sheet renderer, the codec and their tests need no
 * edit at all. That is the registry earning its keep. */
export function ditherSettingControls(onChange: (s: Partial<DitherSettings>) => void): Control[] {
  const available = (ctx: { lookId: string }) =>
    ctx.lookId === 'dither3d'
      ? { ok: true as const }
      : { ok: false as const, reason: 'the dither3d Look only' };
  return [
    {
      kind: 'choice', id: 'dither-colour', label: 'Colour mode', group: 'look',
      help: 'Grayscale is the stronger image, and it makes temperature, moisture, precip, unrest and plates indistinguishable. Colour dithers each channel against the same pattern, so the lens still reads.',
      options: [{ id: 'colour', label: 'colour' }, { id: 'grayscale', label: 'grayscale' }],
      default: DITHER_DEFAULTS.colourMode,
      available,
      apply: (v) => onChange({ colourMode: v as DitherSettings['colourMode'] }),
    },
    {
      kind: 'slider', id: 'dither-dot-scale', label: 'Dot scale', group: 'look',
      min: 0.25, max: 4, step: 0.05, default: DITHER_DEFAULTS.dotScale,
      format: (v) => `${v.toFixed(2)}×`,
      available,
      apply: (v) => onChange({ dotScale: v }),
    },
    {
      kind: 'slider', id: 'dither-contrast', label: 'Contrast', group: 'look',
      min: 0.4, max: 3, step: 0.05, default: DITHER_DEFAULTS.contrast,
      format: (v) => v.toFixed(2),
      available,
      apply: (v) => onChange({ contrast: v }),
    },
    {
      kind: 'slider', id: 'dither-variability', label: 'Dot size variability', group: 'look',
      help: '0 shades by dot COUNT (Bayer); 1 shades by dot SIZE (halftone).',
      min: 0, max: 1, step: 0.05, default: DITHER_DEFAULTS.variability,
      format: (v) => v.toFixed(2),
      available,
      apply: (v) => onChange({ variability: v }),
    },
    {
      kind: 'slider', id: 'dither-stretch', label: 'Stretch smoothness', group: 'look',
      help: 'Softens dots along the stretched axis at a grazing angle.',
      min: 0, max: 1, step: 0.05, default: DITHER_DEFAULTS.stretch,
      format: (v) => v.toFixed(2),
      available,
      apply: (v) => onChange({ stretch: v }),
    },
    {
      kind: 'toggle', id: 'dither-invert', label: 'Invert dots', group: 'look',
      default: DITHER_DEFAULTS.invert,
      available,
      apply: (v) => onChange({ invert: v }),
    },
    {
      kind: 'toggle', id: 'dither-radial', label: 'Radial compensation', group: 'look',
      help: 'Counteracts the density falloff toward the screen edge under a perspective projection.',
      default: DITHER_DEFAULTS.radialCompensation,
      available,
      apply: (v) => onChange({ radialCompensation: v }),
    },
  ];
}
