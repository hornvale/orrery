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
