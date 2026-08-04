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
      marks.replaceChildren();
      for (const mark of eclipseMarkPositions(events, maxDay)) {
        const m = el('button', `eclipse-mark eclipse-${mark.body} eclipse-${mark.kind}`);
        m.style.left = `${mark.leftFraction * 100}%`;
        m.title = `${mark.body} ${mark.kind} eclipse — day ${mark.event.day.toFixed(1)}`;
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
