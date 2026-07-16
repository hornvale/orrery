/** Map-coloring for the plate lens.
 *
 * Seed 42 has 16 plates and the validated palette has 8 slots, so one color
 * per plate is impossible — and cycling `plate % N` would not merely be
 * ugly, it would LIE: two adjacent plates sharing a color read as one plate.
 * Plate ids are arbitrary per-world labels anyway, so color's job here is
 * separation, not identity — the standard cartographic answer.
 *
 * Greedy over a degeneracy (smallest-last) ordering colors any planar graph
 * in ≤ 6 colors, because a planar graph has degeneracy ≤ 5. That is a
 * guarantee rather than a hope, which is why no cycling fallback exists
 * below. Ties break by plate id, which makes the result deterministic. */
import type { TilesScene } from '../sim/scene';
import { HEX } from './colormap';
import type { RGB } from './lens';

/** The six validated slots (spec §7.1). Violet (#9085e9) and magenta
 * (#d55181) are DELIBERATELY ABSENT: measured against surface #05070f,
 * blue↔violet is ΔE 2.5 under protanopia and aqua↔magenta is 4.7 — safe in
 * the palette's canonical order, catastrophic on a map where any two regions
 * can share a border. Do not add them back. */
export const PLATE_SLOTS: readonly RGB[] = [
  HEX('#3987e5'), // blue
  HEX('#199e70'), // aqua
  HEX('#c98500'), // yellow
  HEX('#008300'), // green
  HEX('#e66767'), // red
  HEX('#d95926'), // orange
];

/** Ink for a boundary tile — the secondary encoding the 8-12 CVD floor band
 * requires, and the layer's real information besides. */
export const PLATE_BOUNDARY: RGB = HEX('#05070f');

/** The 4-connected neighbours of tile `i`. Longitude wraps (the lattice is a
 * cylinder); rows do not — the poles are edges. */
function neighbours(tiles: TilesScene, i: number): number[] {
  const { width, height } = tiles;
  const row = Math.floor(i / width);
  const col = i % width;
  const out: number[] = [
    row * width + ((col + 1) % width),
    row * width + ((col - 1 + width) % width),
  ];
  if (row > 0) out.push((row - 1) * width + col);
  if (row < height - 1) out.push((row + 1) * width + col);
  return out;
}

/** Plate id → the set of plate ids it borders. */
export function plateAdjacency(tiles: TilesScene): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const edge = (a: number, b: number) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (let i = 0; i < tiles.plate.length; i++) {
    const p = tiles.plate[i]!;
    if (!adj.has(p)) adj.set(p, new Set());
    for (const n of neighbours(tiles, i)) edge(p, tiles.plate[n]!);
  }
  return adj;
}

/** True when any 4-neighbour of `i` belongs to a different plate. */
export function isBoundaryTile(tiles: TilesScene, i: number): boolean {
  const p = tiles.plate[i]!;
  return neighbours(tiles, i).some((n) => tiles.plate[n]! !== p);
}

/** Plate id → palette slot. Greedy over a degeneracy ordering; ≤ 6 slots on a
 * planar map, deterministic by plate-id tie-break. */
export function colorPlates(tiles: TilesScene): Map<number, number> {
  const adj = plateAdjacency(tiles);

  // Smallest-last ordering: repeatedly strip the lowest-degree vertex from the
  // remaining subgraph. Reversing the strip order gives the degeneracy order,
  // in which greedy needs at most (degeneracy + 1) colors.
  const remaining = new Set(adj.keys());
  const stripped: number[] = [];
  const degree = (id: number) => [...adj.get(id)!].filter((n) => remaining.has(n)).length;
  while (remaining.size > 0) {
    let best: number | null = null;
    let bestDeg = Infinity;
    for (const id of [...remaining].sort((a, b) => a - b)) {  // id order: the tie-break
      const d = degree(id);
      if (d < bestDeg) {
        bestDeg = d;
        best = id;
      }
    }
    remaining.delete(best!);
    stripped.push(best!);
  }
  stripped.reverse();

  const colors = new Map<number, number>();
  for (const id of stripped) {
    const taken = new Set([...adj.get(id)!].map((n) => colors.get(n)).filter((c) => c !== undefined));
    let slot = 0;
    while (taken.has(slot)) slot++;
    if (slot >= PLATE_SLOTS.length) {
      // Unreachable on a planar map (degeneracy ≤ 5 ⇒ ≤ 6 colors). If the
      // lattice ever produces a non-planar adjacency, fail loudly rather than
      // silently cycling two neighbours into the same color.
      throw new Error(`plate ${id} needs slot ${slot}: adjacency is not planar`);
    }
    colors.set(id, slot);
  }
  return colors;
}
