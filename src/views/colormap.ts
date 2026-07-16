/** Colormap primitives: lenses declare stops, these do the arithmetic.
 *
 * Sequential ramps are one hue light→dark; diverging ramps are two hues with
 * a neutral (never a hue) midpoint. Both conventions come from the dataviz
 * skill's color formula and are pinned in the spec's §7 table — the palettes
 * there were validated with its validator, not chosen by eye. */
import { lerpRgb } from './color';
import type { RGB } from './lens';

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Parse `#rrggbb` into 0-255 RGB. */
export const HEX = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Piecewise-linear ramp across evenly spaced `stops`; `t` clamps to [0,1]. */
export function sequential(stops: readonly RGB[], t: number): RGB {
  const c = clamp01(t);
  const last = stops.length - 1;
  const scaled = c * last;
  const i = Math.min(Math.floor(scaled), last - 1);
  return lerpRgb(stops[i]!, stops[i + 1]!, scaled - i) as RGB;
}

/** Two-armed ramp symmetric about 0: `cold` at −extent, `mid` at 0, `hot` at
 * +extent. `v` is in value units and clamps to ±extent. */
export function diverging(cold: RGB, mid: RGB, hot: RGB, v: number, extent: number): RGB {
  const t = clamp01(Math.abs(v) / extent);
  return (v < 0 ? lerpRgb(mid, cold, t) : lerpRgb(mid, hot, t)) as RGB;
}
