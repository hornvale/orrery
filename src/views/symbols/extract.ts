import type { TilesScene } from '../../sim/scene';
export { clusterFeatures } from '../globe';

/** A land local-maximum tile, drawn as a peak symbol. */
export interface Peak { lat: number; lon: number; elevationM: number; tileIndex: number; }
/** A connected forest-biome region, drawn as a scatter of tree symbols. */
export interface ForestRegion { lat: number; lon: number; area: number; tileIndex: number; }

/** Biome names (in biomeLegend) drawn as forest. Anything else is not. */
export const FOREST_BIOMES: ReadonlySet<string> = new Set([
  'taiga', 'boreal-forest', 'temperate-forest', 'temperate-rainforest',
  'tropical-seasonal-forest', 'tropical-rainforest',
]);

const tileLat = (y: number, h: number): number => 90 - ((y + 0.5) / h) * 180;
const tileLon = (x: number, w: number): number => -180 + ((x + 0.5) / w) * 360;

/** Land tiles that exceed all in-bounds 4-neighbours (orthogonal: N/S/E/W)
 * in elevation, tallest first. Deterministic; strict `>` over neighbours
 * (equal-height neighbours both fail, acceptable for symbols). Orthogonal
 * rather than 8-neighbour adjacency: a diagonal neighbour one row/column
 * away belongs to a distinct ridge line and shouldn't disqualify a peak. */
export function extractPeaks(tiles: TilesScene): Peak[] {
  const { width: w, height: h, elevation_m: e, ocean } = tiles;
  const out: Peak[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ocean[i]) continue;
      const ei = e[i]!;
      let isMax = true;
      const nbrs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const n of nbrs) {
        if (n >= 0 && e[n]! >= ei) { isMax = false; break; }
      }
      if (isMax) out.push({ lat: tileLat(y, h), lon: tileLon(x, w), elevationM: ei, tileIndex: i });
    }
  }
  return out.sort((a, b) => b.elevationM - a.elevationM);
}

/** Connected components (4-neighbour) of forest-biome tiles, largest area
 * first. Centroid in lat/lon; a representative tileIndex for the scatter seed. */
export function extractForests(tiles: TilesScene): ForestRegion[] {
  const { width: w, height: h, biome, biomeLegend, ocean } = tiles;
  const isForest = (i: number) => !ocean[i] && FOREST_BIOMES.has(biomeLegend[biome[i]!]!);
  const seen = new Uint8Array(w * h);
  const out: ForestRegion[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !isForest(s)) continue;
    let area = 0, sumLat = 0, sumLon = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      area++; sumLat += tileLat(y, h); sumLon += tileLon(x, w);
      const nbrs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const n of nbrs) if (n >= 0 && !seen[n] && isForest(n)) { seen[n] = 1; stack.push(n); }
    }
    out.push({ lat: sumLat / area, lon: sumLon / area, area, tileIndex: s });
  }
  return out.sort((a, b) => b.area - a.area);
}
