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
