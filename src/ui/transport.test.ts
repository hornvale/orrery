import { describe, expect, it } from 'vitest';
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

  it('shows the current rate as a chip', () => {
    const t = buildTransport(noop);
    t.setRateLabel('1 hr/s');
    expect(t.element.querySelector('[data-transport="rate"]')!.textContent).toBe('1 hr/s');
  });
});
