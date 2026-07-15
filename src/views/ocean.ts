/** The ocean layer: a smooth, translucent sea-level sphere over the
 * displaced seafloor (spec: docs/superpowers/specs/2026-07-15-watery-oceans-design.md).
 * Same split as the other views: pure grading/radius math (unit-tested
 * directly), then the three.js builder that consumes it. */
import type { TilesScene } from '../sim/scene';
import { REFERENCE_RADIUS_M } from './worldMesh';

/** Depth (m below sea level) at which water reaches full darkness/opacity. */
export const DEEP_FULL_M = 3000;
/** Water alpha over the shallowest ocean (seafloor clearly visible). */
export const SHALLOW_ALPHA = 0.35;
/** Water alpha at DEEP_FULL_M and beyond (nearly opaque). */
export const DEEP_ALPHA = 0.92;
/** Shallow-water tint (0-1 channels) — a tuning knob, not a contract. */
export const SHALLOW_COLOR: [number, number, number] = [0.55, 0.8, 0.85];
/** Deep-water tint (0-1 channels) — a tuning knob, not a contract. */
export const DEEP_COLOR: [number, number, number] = [0.02, 0.15, 0.3];

/** The sea sphere's radius: exactly where `buildFaceGeometry` puts sea level
 * for this `reliefScale` (sea_level_m is datum-relative and negative in
 * practice, so this sits below the undisplaced radius). */
export function seaLevelRadius(tiles: TilesScene, radius: number, reliefScale: number): number {
  return radius * (1 + (reliefScale * tiles.sea_level_m) / REFERENCE_RADIUS_M);
}

/** Depth-graded water: pale, translucent aqua over the shallows smoothing to
 * near-opaque dark blue by DEEP_FULL_M. Callers gate land to alpha 0 with the
 * tile's own `ocean` flag — depth alone can't tell coastal land (elevation at
 * exactly sea level) from zero-depth sea. */
export function waterColorAlpha(depthM: number): { r: number; g: number; b: number; a: number } {
  const t = Math.min(1, Math.max(0, depthM / DEEP_FULL_M));
  const s = t * t * (3 - 2 * t); // smoothstep
  const lerp = (from: number, to: number) => from + (to - from) * s;
  return {
    r: lerp(SHALLOW_COLOR[0], DEEP_COLOR[0]),
    g: lerp(SHALLOW_COLOR[1], DEEP_COLOR[1]),
    b: lerp(SHALLOW_COLOR[2], DEEP_COLOR[2]),
    a: lerp(SHALLOW_ALPHA, DEEP_ALPHA),
  };
}
