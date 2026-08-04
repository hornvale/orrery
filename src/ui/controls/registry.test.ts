import { describe, expect, it } from 'vitest';
import { buildRegistry, SHEET_TABS, type RegistryDeps } from './registry';
import { LENSES } from '../../views/lens';
import { LOOKS } from '../../views/look';
import type { Control } from './kinds';

/** Every dep is a no-op recorder: the registry test cares about the SHAPE of
 * the control list, not what any apply does. */
function deps(): RegistryDeps {
  const nop = () => {};
  return {
    setLens: nop, setLook: nop, setWinds: nop, setCurrents: nop, setClouds: nop,
    setWaves: nop, setGlint: nop, setNightFill: nop, setTrueRelief: nop,
    setTrueDistance: nop, setHoldSpin: nop, setHoldSeason: nop, setRate: nop,
    reroll: nop, share: nop,
    lookSettings: () => [],
    lensLegend: () => [],
  };
}

function ids(controls: Control[]): string[] { return controls.map((c) => c.id); }

describe('the control registry', () => {
  it('gives every control a unique id', () => {
    const r = buildRegistry(deps());
    expect(new Set(ids(r)).size).toBe(r.length);
  });

  it('uses only URL-safe ids, since the codec writes them into the hash', () => {
    for (const c of buildRegistry(deps())) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('puts every control in a group that has a tab or is the world group', () => {
    const tabbed = new Set(SHEET_TABS.map((t) => t.group));
    for (const c of buildRegistry(deps())) {
      expect(tabbed.has(c.group) || c.group === 'world').toBe(true);
    }
  });

  it('gives every choice a default that is one of its own options', () => {
    for (const c of buildRegistry(deps())) {
      if (c.kind === 'choice') {
        expect(c.options.map((o) => o.id)).toContain(c.default);
      }
    }
  });

  it('gives every slider a default inside its own range', () => {
    for (const c of buildRegistry(deps())) {
      if (c.kind === 'slider') {
        expect(c.default).toBeGreaterThanOrEqual(c.min);
        expect(c.default).toBeLessThanOrEqual(c.max);
        expect(c.step).toBeGreaterThan(0);
      }
    }
  });

  it('offers every registered lens and every registered Look', () => {
    const r = buildRegistry(deps());
    const lens = r.find((c) => c.id === 'lens')!;
    const look = r.find((c) => c.id === 'look')!;
    expect(lens.kind).toBe('choice');
    expect(look.kind).toBe('choice');
    if (lens.kind === 'choice') expect(lens.options.map((o) => o.id)).toEqual(LENSES.map((l) => l.id));
    if (look.kind === 'choice') expect(look.options.map((o) => o.id)).toEqual(LOOKS.map((l) => l.id));
  });

  it('merges the active Looks own settings into the list', () => {
    const withSetting = {
      ...deps(),
      lookSettings: () => ([{
        kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
        min: 0.5, max: 4, step: 0.1, default: 1, apply: () => {},
      }] as Control[]),
    };
    expect(ids(buildRegistry(withSetting))).toContain('dot-scale');
  });

  it('gates relief to the globe rung and distance to the system rung', () => {
    const r = buildRegistry(deps());
    const relief = r.find((c) => c.id === 'relief')!;
    const distance = r.find((c) => c.id === 'distance')!;
    const ctx = (rung: 'system' | 'globe' | 'map') => ({ rung, tiles: {} as never, lookId: 'natural' });
    expect(relief.available!(ctx('globe')).ok).toBe(true);
    expect(relief.available!(ctx('system')).ok).toBe(false);
    expect(distance.available!(ctx('system')).ok).toBe(true);
    expect(distance.available!(ctx('globe')).ok).toBe(false);
  });

  it('gives the lens control a legend, so its colour key renders', () => {
    const r = buildRegistry(deps());
    const lens = r.find((c) => c.id === 'lens')!;
    expect(lens.kind).toBe('choice');
    if (lens.kind === 'choice') expect(typeof lens.legend).toBe('function');
  });
});
