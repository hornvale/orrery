import { describe, expect, it, vi } from 'vitest';
import { buildTransport } from './transport';
import type { EclipseEvent } from '../sim/scene';

const noop = { onPlayPause() {}, onScrub(_: number) {}, onEclipseMark(_: EclipseEvent) {}, onRateChip() {} };

describe('the transport', () => {
  it('reports play/pause and reflects the paused state', () => {
    let fired = 0;
    const t = buildTransport({ ...noop, onPlayPause: () => { fired++; } });
    const btn = t.element.querySelector('[data-transport="play"]') as HTMLButtonElement;
    btn.click();
    expect(fired).toBe(1);
    t.setPaused(true);
    expect(btn.textContent).toBe('▶');
    t.setPaused(false);
    expect(btn.textContent).toBe('⏸');
  });

  it('reports a scrub', () => {
    let got: number | null = null;
    const t = buildTransport({ ...noop, onScrub: (d) => { got = d; } });
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    scrub.value = '120.5';
    scrub.dispatchEvent(new Event('input'));
    expect(got).toBe(120.5);
  });

  it('setDay moves the scrubber without firing onScrub', () => {
    let fired = 0;
    const t = buildTransport({ ...noop, onScrub: () => { fired++; } });
    t.setDayRange(365);
    t.setDay(200);
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    expect(scrub.value).toBe('200');
    expect(fired).toBe(0);
  });

  it('places one eclipse mark per event and reports a click', () => {
    // Real EclipseEvent (src/sim/scene.ts): `body` is the eclipse TYPE
    // ("solar" | "lunar"), `kind` is "total" | "annular", and a solar event
    // requires a non-null `track` (GroundTrack) while a lunar event requires
    // `track: null`. `moonIndex` is also required.
    const events: EclipseEvent[] = [
      {
        day: 50,
        moonIndex: 0,
        body: 'solar',
        kind: 'total',
        track: { centerLatDeg: 10, halfWidthDeg: 1.5, startLonDeg: -20, endLonDeg: 30, durationDays: 0.05 },
      },
      { day: 300, moonIndex: 0, body: 'lunar', kind: 'total', track: null },
    ];
    let got: EclipseEvent | null = null;
    const t = buildTransport({ ...noop, onEclipseMark: (e) => { got = e; } });
    t.setEclipses(events, 365);
    const marks = [...t.element.querySelectorAll('.eclipse-mark')] as HTMLButtonElement[];
    expect(marks.length).toBe(2);
    marks[1]!.click();
    expect(got).toBe(events[1]);
  });

  it('a tap on the scrubber near a mark (small movement) reports it — the real-pointer path, since the mark itself is pointer-events:none', () => {
    const events: EclipseEvent[] = [
      { day: 50, moonIndex: 0, body: 'solar', kind: 'total', track: null },
      { day: 300, moonIndex: 0, body: 'lunar', kind: 'total', track: null },
    ];
    let got: EclipseEvent | null = null;
    const t = buildTransport({ ...noop, onEclipseMark: (e) => { got = e; } });
    t.setEclipses(events, 365);
    const marksEl = t.element.querySelector('.eclipse-marks') as HTMLElement;
    // jsdom/happy-dom never lays anything out, so getBoundingClientRect is
    // all zeros by default — stand in a fixed 200px-wide box to give the
    // hit-test something real to measure against.
    vi.spyOn(marksEl, 'getBoundingClientRect').mockReturnValue(
      { left: 0, right: 200, width: 200, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => '' } as DOMRect,
    );
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    // day 300 of 365 -> leftFraction ≈ 0.8219 -> x ≈ 164.4px into the 200px box.
    scrub.dispatchEvent(new PointerEvent('pointerdown', { clientX: 165 }));
    scrub.dispatchEvent(new PointerEvent('pointerup', { clientX: 166 })); // 1px — a tap
    expect(got).toBe(events[1]);
  });

  it('a drag (large movement between pointerdown and pointerup) does not report a mark, even one it passes over', () => {
    const events: EclipseEvent[] = [
      { day: 300, moonIndex: 0, body: 'lunar', kind: 'total', track: null },
    ];
    let fired = 0;
    const t = buildTransport({ ...noop, onEclipseMark: () => { fired++; } });
    t.setEclipses(events, 365);
    const marksEl = t.element.querySelector('.eclipse-marks') as HTMLElement;
    vi.spyOn(marksEl, 'getBoundingClientRect').mockReturnValue(
      { left: 0, right: 200, width: 200, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => '' } as DOMRect,
    );
    const scrub = t.element.querySelector('input[type="range"]') as HTMLInputElement;
    scrub.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0 }));
    scrub.dispatchEvent(new PointerEvent('pointerup', { clientX: 165 })); // sails past the mark — a drag
    expect(fired).toBe(0);
  });

  it('shows the current rate as a chip', () => {
    const t = buildTransport(noop);
    t.setRateLabel('1 hr/s');
    expect(t.element.querySelector('[data-transport="rate"]')!.textContent).toBe('1 hr/s');
  });
});
