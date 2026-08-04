import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collapses a rapid burst into a single trailing call', () => {
    const fn = vi.fn();
    const trigger = debounce(fn, 100);
    for (let i = 0; i < 50; i++) trigger(); // a slider firing on every drag tick
    expect(fn).not.toHaveBeenCalled(); // nothing yet — still inside the quiet window
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1); // far fewer writes than sets
  });

  it("the one call that fires reads whatever is current, so the burst's FINAL value always lands", () => {
    let value = 0;
    const seen: number[] = [];
    const trigger = debounce(() => seen.push(value), 100);
    value = 1; trigger();
    value = 2; trigger();
    value = 3; trigger(); // the last value of the burst
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([3]); // not [1] (the first call) or dropped entirely
  });

  // The window is the trailing edge's one hole: a page that goes away inside
  // it loses the pending write entirely. `flush` is what a `pagehide`
  // listener calls to close it.
  it('flush runs a pending call immediately, so a close inside the window does not drop it', () => {
    const fn = vi.fn();
    const trigger = debounce(fn, 100);
    trigger();
    expect(fn).not.toHaveBeenCalled(); // inside the window: without a flush this write is lost
    trigger.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush cancels the timer it fired for, so the call does not land twice', () => {
    const fn = vi.fn();
    const trigger = debounce(fn, 100);
    trigger();
    trigger.flush();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1); // not 2 — the pending timer was cleared
  });

  it('flush reads current state too, so it lands the burst\'s final value, not the first', () => {
    let value = 0;
    const seen: number[] = [];
    const trigger = debounce(() => seen.push(value), 100);
    value = 1; trigger();
    value = 2; trigger();
    value = 3; trigger();
    trigger.flush();
    expect(seen).toEqual([3]);
  });

  it('flush with nothing pending is a no-op, so a listener may fire it unconditionally', () => {
    const fn = vi.fn();
    const trigger = debounce(fn, 100);
    trigger.flush(); // never triggered at all
    expect(fn).not.toHaveBeenCalled();
    trigger();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    trigger.flush(); // already fired naturally
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires again for activity after a prior debounced call already landed', () => {
    const fn = vi.fn();
    const trigger = debounce(fn, 100);
    trigger();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    trigger();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
