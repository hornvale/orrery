/** The computed-terminator moon disc: a continuously-oriented phase, not a fixed glyph set. */

const TAU = Math.PI * 2;

/** Illuminated fraction (0 new → 1 full) for a synodic phase in [0,1). */
export function illuminatedFraction(phase: number): number {
  return (1 - Math.cos(TAU * phase)) / 2;
}
