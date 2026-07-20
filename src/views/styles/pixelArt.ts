import type { RenderStyle } from '../renderStyle';
import { pixelBaseTreatment } from './pixelBase';

/** Data-native pixel-art: a quantized biome/coastline base (reads tile data,
 * so land never takes the ocean's colour) plus the symbol layer (peaks +
 * forests) on the globe. A scene renderer, not a screen-space filter. */
export const pixelArtStyle: RenderStyle = {
  id: 'pixel-art',
  label: 'pixel-art',
  passes: () => [],
  base: pixelBaseTreatment,
  symbolLayer: { id: 'world-symbols' },
};
