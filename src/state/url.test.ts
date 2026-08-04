import { describe, expect, it } from 'vitest';
import { defaultAppState, parseAppState, seedError, serializeAppState, type AppState } from './url';

describe('parseAppState', () => {
  it('parses a full state', () => {
    expect(parseAppState('#seed=1337&view=globe&day=118.3')).toEqual({
      seed: '1337',
      view: 'globe',
      day: 118.3,
      controls: '',
    });
  });
  it('defaults everything but the seed', () => {
    expect(parseAppState('#seed=42')).toEqual(defaultAppState('42'));
  });
  it('canonicalizes the seed', () => {
    expect(parseAppState('#seed=007')!.seed).toBe('7');
  });
  it('returns null without a valid seed', () => {
    expect(parseAppState('')).toBeNull();
    expect(parseAppState('#view=globe&day=5')).toBeNull();
    expect(parseAppState('#seed=18446744073709551616')).toBeNull();
    expect(parseAppState('#seed=abc')).toBeNull();
  });
  it('ignores unknown params', () => {
    expect(parseAppState('#seed=42&foo=bar&bogus=1')).toEqual(defaultAppState('42'));
  });
  it('falls back to the system view for anything but "globe"', () => {
    expect(parseAppState('#seed=1&view=sideways')!.view).toBe('system');
    expect(parseAppState('#seed=1&view=')!.view).toBe('system');
  });
  it('falls back to day 0 for a non-finite or absent day', () => {
    expect(parseAppState('#seed=1&day=abc')!.day).toBe(0);
    expect(parseAppState('#seed=1&day=')!.day).toBe(0);
    expect(parseAppState('#seed=1')!.day).toBe(0);
  });
  it('accepts a negative day', () => {
    expect(parseAppState('#seed=1&day=-42.5')!.day).toBe(-42.5);
  });
});

describe('serializeAppState', () => {
  it('omits defaults', () => {
    expect(serializeAppState(defaultAppState('42'))).toBe('#seed=42');
  });
  it('round-trips a full state', () => {
    const full: AppState = { seed: '1337', view: 'globe', day: 118.3, controls: 'winds:1' };
    expect(parseAppState(serializeAppState(full))).toEqual(full);
  });
  it('rounds day to 4 decimals', () => {
    expect(serializeAppState({ seed: '1', view: 'system', day: 12.345678, controls: '' })).toBe('#seed=1&day=12.3457');
  });
  it('round-trips a negative day', () => {
    const s: AppState = { seed: '1', view: 'system', day: -3.5, controls: '' };
    expect(parseAppState(serializeAppState(s))).toEqual(s);
  });
  it('omits day when exactly 0', () => {
    expect(serializeAppState({ seed: '1', view: 'globe', day: 0, controls: '' })).toBe('#seed=1&view=globe');
  });
});

describe('AppState controls', () => {
  it('round-trips an encoded control blob', () => {
    const hash = serializeAppState({ seed: '42', view: 'globe', day: 0, controls: 'look:dither3d,winds:1' });
    expect(parseAppState(hash)!.controls).toBe('look:dither3d,winds:1');
  });

  it('omits the control param when nothing differs from default', () => {
    expect(serializeAppState({ seed: '42', view: 'system', day: 0, controls: '' })).toBe('#seed=42');
  });

  it('defaults controls to empty when the param is absent', () => {
    expect(parseAppState('#seed=42')!.controls).toBe('');
  });
});

describe('seedError', () => {
  it('is null when the seed is valid', () => {
    expect(seedError('#seed=42')).toBeNull();
    expect(seedError('#seed=007')).toBeNull();
  });
  it('is null when the seed is entirely absent', () => {
    expect(seedError('')).toBeNull();
    expect(seedError('#view=globe&day=5')).toBeNull();
  });
  it('names the bad seed', () => {
    expect(seedError('#seed=abc')).toContain('abc');
  });
  it('flags a negative or non-integer seed', () => {
    expect(seedError('#seed=-3')).not.toBeNull();
    expect(seedError('#seed=4.5')).not.toBeNull();
  });
  it('flags an out-of-range (> u64::MAX) seed', () => {
    expect(seedError('#seed=18446744073709551616')).not.toBeNull();
  });
});
