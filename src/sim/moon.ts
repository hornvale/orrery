/** The computed-terminator moon disc: a continuously-oriented phase, not a fixed glyph set. */

const TAU = Math.PI * 2;

/** Illuminated fraction (0 new → 1 full) for a synodic phase in [0,1). */
export function illuminatedFraction(phase: number): number {
  return (1 - Math.cos(TAU * phase)) / 2;
}

/** Terminator ellipse x-radius as a fraction of the disc radius: |1−2k|. */
export function litOffset(phase: number): number {
  return Math.abs(1 - 2 * illuminatedFraction(phase));
}

/**
 * Draw a moon: dark disc, sunward semicircle lit, then a terminator ellipse
 * that carves a crescent (k<½) or extends a gibbous (k>½). The whole is
 * rotated so the lit limb faces `sunAngle` (screen radians, 0 = +x).
 */
export function drawMoon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  phase: number,
  sunAngle: number,
  lit = "#ece6cf",
  dark = "#31363f",
): void {
  const k = illuminatedFraction(phase);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sunAngle); // local frame: sun toward +x
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false); // sunward (right) half
  ctx.closePath();
  ctx.fillStyle = lit;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0, r * litOffset(phase), r, 0, 0, TAU);
  ctx.fillStyle = k < 0.5 ? dark : lit;
  ctx.fill();
  ctx.restore();
}
