/** Pure placement math for the day-scrubber's eclipse marks: where each
 * event lands along the scrubber track, and what it should carry so a click
 * can open its inspector card. No DOM here — see transport.ts's
 * `div.eclipse-marks` for the overlay this feeds. */
import type { EclipseEvent } from '../sim/scene';

/** One eclipse mark's placement on the scrubber track. */
export interface EclipseMarkPosition {
  /** Fractional position along the scrubber, `day / maxDay`, in `[0, 1]`. */
  leftFraction: number;
  body: EclipseEvent['body'];
  kind: EclipseEvent['kind'];
  /** The originating event, carried through for the click handler. */
  event: EclipseEvent;
}

/** Places `events` along a `[0, maxDay]` scrubber. Events whose `day` falls
 * outside that range are dropped (defensive — the query window that
 * produced `events` already bounds them; this never clamps). */
export function eclipseMarkPositions(events: EclipseEvent[], maxDay: number): EclipseMarkPosition[] {
  const marks: EclipseMarkPosition[] = [];
  for (const event of events) {
    if (event.day < 0 || event.day > maxDay) continue;
    marks.push({ leftFraction: event.day / maxDay, body: event.body, kind: event.kind, event });
  }
  return marks;
}
