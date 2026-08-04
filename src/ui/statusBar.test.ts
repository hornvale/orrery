import { describe, expect, it } from 'vitest';
import { buildStatusBar } from './statusBar';
import type { ZoomTarget } from '../views/zoom';

const noop = { onRung(_: ZoomTarget) {}, onOverflow() {}, onLensChip() {}, onDateChip() {} };

describe('the status bar', () => {
  it('offers all three rungs', () => {
    const bar = buildStatusBar(noop);
    expect([...bar.element.querySelectorAll('[data-rung]')].map((b) => b.getAttribute('data-rung')))
      .toEqual(['system', 'globe', 'map']);
  });

  it('reports the rung the viewer picked', () => {
    let got: ZoomTarget | null = null;
    const bar = buildStatusBar({ ...noop, onRung: (v) => { got = v; } });
    (bar.element.querySelector('[data-rung="map"]') as HTMLButtonElement).click();
    expect(got).toBe('map');
  });

  it('setRung marks the active rung without firing onRung', () => {
    let fired = 0;
    const bar = buildStatusBar({ ...noop, onRung: () => { fired++; } });
    bar.setRung('globe');
    const active = [...bar.element.querySelectorAll('[data-rung].active')];
    expect(active.map((b) => b.getAttribute('data-rung'))).toEqual(['globe']);
    expect(fired).toBe(0);
  });

  it('shows the date and the active lens', () => {
    const bar = buildStatusBar(noop);
    bar.setDate('Year 3, day 214');
    bar.setLens('temperature');
    expect(bar.element.querySelector('[data-status="date"]')!.textContent).toBe('Year 3, day 214');
    expect(bar.element.querySelector('[data-status="lens"]')!.textContent).toBe('temperature');
  });

  it('flashShared confirms then restores the seed line', () => {
    const bar = buildStatusBar(noop);
    bar.setSeed('42');
    const seed = bar.element.querySelector('[data-status="seed"]')!;
    expect(seed.textContent).toBe('seed 42');
    bar.flashShared();
    expect(seed.textContent).toBe('copied ✓');
  });
});
