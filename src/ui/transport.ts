/** The persistent bottom chrome — play/pause, the day scrubber with its
 * eclipse marks, and the current rate as a read-only chip (tapping it opens
 * the Time tab, which owns the rate picker).
 *
 * The scrubber stays BESPOKE rather than becoming a registry slider, by
 * decision (Console spec §1): it carries the eclipse-mark overlay and must
 * distinguish a user drag (fires onScrub) from autoplay driving it
 * (setDay, silent). Neither fits the generic slider contract. */
import type { EclipseEvent } from '../sim/scene';
import { eclipseMarkPositions } from './eclipseMarks';

export interface Transport {
  element: HTMLElement;
  setPaused(p: boolean): void;
  setDay(day: number): void;
  setDayRange(maxDay: number): void;
  setRateLabel(s: string): void;
  setEclipses(events: EclipseEvent[], maxDay: number): void;
}

export function buildTransport(cb: {
  onPlayPause(): void;
  onScrub(day: number): void;
  onEclipseMark(e: EclipseEvent): void;
  onRateChip(): void;
}): Transport {
  const element = el('div', 'transport');

  const play = el('button', 'transport-play');
  play.dataset.transport = 'play';
  play.textContent = '⏸';
  play.setAttribute('aria-label', 'play or pause');
  play.addEventListener('click', () => cb.onPlayPause());

  // The marks overlay MUST be a child of this positioned track wrapper —
  // an absolutely-positioned child needs a positioned ancestor or it is both
  // invisible AND unclickable (a real past regression, caught only by a
  // visual pass, not by the DOM tests).
  const track = el('div', 'transport-track');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.name = 'day-scrubber';
  scrub.min = '0';
  scrub.max = '1000'; // placeholder — setDayRange sets the real extent once a world loads
  scrub.step = '0.01';
  scrub.value = '0';
  scrub.addEventListener('input', () => cb.onScrub(Number(scrub.value)));
  const marks = el('div', 'eclipse-marks');
  track.append(scrub, marks);

  // The marks are `pointer-events: none` (styles.css) — a REAL pointer never
  // hits one; it always lands on `scrub` underneath, so a drag that starts
  // "on" a mark still scrubs, unconditionally, by construction (round 2's
  // fix: an enlarged CSS hit-box on the mark itself, tried first, shadowed
  // enough of the track's own drag surface through a dense cluster to make
  // grabbing the scrubber there unreliable). Tapping a mark is instead
  // recovered here, in JS, as a generous-radius hit-test against `scrub`'s
  // own pointerdown/pointerup, gated on movement distance (see below) so a
  // genuine drag is never misread as a tap.
  //
  // Cost, stated plainly: a tap that lands near a mark ALSO moves `scrub`'s
  // value to that exact pixel (and fires `onScrub`) — previously it did not,
  // because the mark's own `pointer-events: auto` ate the whole interaction
  // before it ever reached the input. That coupling ("tapping an eclipse
  // also jumps you to about that day") is judged a reasonable trade, not a
  // free one — flagged in the task report, not hidden.
  // Movement only, deliberately no hold-time gate: unlike `main.ts`'s
  // globe-inspector `pick()` (mouse orbit-drags can have near-zero net
  // displacement over a long hold, so IT needs a duration check too), a
  // range input's drag has no legitimate zero-movement-but-long-hold case —
  // moving the thumb IS the movement. A duration gate here turned out to be
  // actively harmful, not just unnecessary: measured on a busy page (right
  // after several tab switches, with the globe's own animation loop still
  // running), a synthetic tap's own pointerdown-to-pointerup dispatch
  // latency alone hit 636ms — comfortably past a 500ms budget for
  // dispatch overhead having nothing to do with how long anyone actually
  // held it down. Distance is load-independent; duration under a busy page
  // is not.
  const TAP_MOVE_PX = 5; // mirrors main.ts's pick() click-vs-drag distance threshold
  const MARK_HIT_RADIUS_PX = 22; // half of --tap (44px) — the same floor the CSS used to encode
  let currentMarks: ReturnType<typeof eclipseMarkPositions> = [];
  let downAt: { x: number } | null = null;
  scrub.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX }; });
  scrub.addEventListener('pointerup', (e) => {
    if (!downAt || currentMarks.length === 0) { downAt = null; return; }
    const moved = Math.abs(e.clientX - downAt.x);
    downAt = null;
    if (moved > TAP_MOVE_PX) return; // a drag, not a tap
    const box = marks.getBoundingClientRect(); // marks' own box, not track's — it's inset 8px each side
    if (box.width === 0) return;
    const tapX = e.clientX - box.left;
    let nearest: (typeof currentMarks)[number] | null = null;
    let nearestDist = Infinity;
    for (const m of currentMarks) {
      const dist = Math.abs(tapX - m.leftFraction * box.width);
      if (dist < nearestDist) { nearestDist = dist; nearest = m; }
    }
    if (nearest && nearestDist <= MARK_HIT_RADIUS_PX) cb.onEclipseMark(nearest.event);
  });

  const rate = el('button', 'transport-rate');
  rate.dataset.transport = 'rate';
  rate.textContent = '1×';
  rate.addEventListener('click', () => cb.onRateChip());

  element.append(play, track, rate);

  return {
    element,
    setPaused: (p) => { play.textContent = p ? '▶' : '⏸'; },
    setDay: (day) => { scrub.value = String(day); },
    setDayRange: (maxDay) => { scrub.max = String(maxDay); },
    setRateLabel: (s) => { rate.textContent = s; },
    setEclipses: (events, maxDay) => {
      currentMarks = eclipseMarkPositions(events, maxDay);
      marks.replaceChildren();
      for (const mark of currentMarks) {
        const m = el('button', `eclipse-mark eclipse-${mark.body} eclipse-${mark.kind}`);
        m.style.left = `${mark.leftFraction * 100}%`;
        m.title = `${mark.body} ${mark.kind} eclipse — day ${mark.event.day.toFixed(1)}`;
        // Dead for a real pointer (the mark is `pointer-events: none` in
        // styles.css, so a mouse/touch tap never actually reaches this
        // button — see the pointerdown/pointerup hit-test above, which is
        // what real input goes through). Kept for keyboard: Tab still
        // focuses the button (pointer-events doesn't gate focus), and
        // Enter/Space dispatch a real `click` straight to it, bypassing
        // hit-testing entirely.
        m.addEventListener('click', () => cb.onEclipseMark(mark.event));
        marks.appendChild(m);
      }
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
