import { describe, expect, it } from 'vitest';
import { DayHoldCoupling, SPEED_POLICY, SpeedMemory, clampMult, reconcileDayHold } from './speedPolicy';
import { buildRegistry, rateId, type RegistryDeps } from '../ui/controls/registry';
import { ControlStore } from '../ui/controls/store';
import type { ZoomTarget } from '../views/zoom';

describe('speed policy', () => {
  it('system rung defaults to ~1 mo/s and is uncapped', () => {
    expect(SPEED_POLICY.system).toEqual({ defaultMult: 2.6e6, maxMult: null });
  });
  it('globe rung defaults to 1 hr/s and caps at ~1 mo/s', () => {
    expect(SPEED_POLICY.globe).toEqual({ defaultMult: 3600, maxMult: 2.6e6 });
  });
  it('passes the fast rates at the globe now that the cap is raised', () => {
    expect(clampMult('globe', 2.6e6)).toBe(2.6e6);
    expect(clampMult('system', 2.6e6)).toBe(2.6e6);
  });
  it('still clamps a rate above the raised globe cap', () => {
    expect(clampMult('globe', 1e7)).toBe(2.6e6);
  });
  it('restores the default before any choice, the last choice after', () => {
    const mem = new SpeedMemory();
    expect(mem.restore('globe')).toBe(3600);
    mem.remember('globe', 86400);
    expect(mem.restore('globe')).toBe(86400);
    expect(mem.restore('system')).toBe(2.6e6); // per-rung, not global
  });
  it('a remembered over-cap value restores clamped', () => {
    const mem = new SpeedMemory();
    mem.remember('globe', 1e7);
    expect(mem.restore('globe')).toBe(2.6e6);
  });
});

describe('reconcileDayHold', () => {
  it('disengages day-hold when a fast mult (into the seasonal-hold regime) is picked', () => {
    const calls: string[] = [];
    const on = reconcileDayHold(
      true,
      2.6e6,
      86400,
      (v) => calls.push(`setDayHold(${v})`),
      (v) => calls.push(`setDayHoldActive(${v})`),
    );
    expect(on).toBe(false);
    expect(calls).toEqual(['setDayHold(false)', 'setDayHoldActive(false)']);
  });
  it('leaves day-hold engaged, with no calls, at a slow mult', () => {
    const calls: string[] = [];
    const on = reconcileDayHold(
      true,
      3600,
      86400,
      (v) => calls.push(`setDayHold(${v})`),
      (v) => calls.push(`setDayHoldActive(${v})`),
    );
    expect(on).toBe(true);
    expect(calls).toEqual([]);
  });
  it('is a no-op when day-hold is already off, regardless of mult', () => {
    const calls: string[] = [];
    const on = reconcileDayHold(
      false,
      2.6e6,
      86400,
      (v) => calls.push(`setDayHold(${v})`),
      (v) => calls.push(`setDayHoldActive(${v})`),
    );
    expect(on).toBe(false);
    expect(calls).toEqual([]);
  });
});

/** main.ts's clock wiring with the views left out: the REAL registry and a
 * REAL store, plus the picker write-back that `applyRate` performs — a rate
 * change writes its own id back into the store, which re-enters `setRate`.
 * That re-entrancy is exactly what the coupling's guard exists for, so a
 * harness without it could not fail. */
function wireRung(rung: ZoomTarget, startMult: number) {
  let mult = 0;
  const seasonPin: boolean[] = []; // what the globe was told, in order
  let store!: ControlStore;

  function applyRate(m: number): number {
    mult = clampMult(rung, m);
    const picked = rateId(mult);
    if (store.get('rate') !== picked) store.set('rate', picked);
    return mult;
  }

  const dayHold = new DayHoldCoupling({
    seasonalHoldMult: 86400,
    mult: () => mult,
    watchableMult: () => SPEED_POLICY[rung].defaultMult,
    applyRate: (m) => { applyRate(m); },
    setDayHold: (on) => { seasonPin.push(on); },
    held: () => store.get('hold-season') === true,
    setHeld: (on) => { if (store.get('hold-season') !== on) store.set('hold-season', on); },
  });

  const nop = () => {};
  const deps: RegistryDeps = {
    setLens: nop, setLook: nop, setWinds: nop, setCurrents: nop, setClouds: nop,
    setWaves: nop, setGlint: nop, setNightFill: nop, setTrueRelief: nop,
    setTrueDistance: nop, setHoldSpin: nop, reroll: nop, share: nop,
    lookSettings: () => [],
    setHoldSeason: (on) => dayHold.engage(on),
    setRate: (m) => dayHold.reconcile(applyRate(m)),
  };
  store = new ControlStore(buildRegistry(deps));
  store.set('rate', rateId(startMult)); // the rate the rung starts at
  return { store, mult: () => mult, seasonPinnedTo: () => seasonPin.at(-1) };
}

describe('the day hold’s coupling to the clock', () => {
  it('sticks on the system rung, whose own default rate is itself in the fast regime', () => {
    // The regression: at 10 d/s the engage drops to the rung default
    // (~1 mo/s), that write re-enters setRate, and an unguarded reconcile
    // sees a held day at a fast rate and cancels the very hold that asked
    // for the drop. The toggle flipped on and straight back off.
    const h = wireRung('system', 864000);
    h.store.set('hold-season', true);
    expect(h.store.get('hold-season')).toBe(true);
    expect(h.seasonPinnedTo()).toBe(true); // and the globe stayed pinned
    expect(h.mult()).toBe(2.6e6);
  });

  it('sticks at ~1 mo/s too, where the drop is a no-op and nothing re-enters', () => {
    const h = wireRung('system', 2.6e6);
    h.store.set('hold-season', true);
    expect(h.store.get('hold-season')).toBe(true);
    expect(h.mult()).toBe(2.6e6);
  });

  it('drops a fast globe rate to the rung’s watchable default and stays held', () => {
    const h = wireRung('globe', 864000);
    h.store.set('hold-season', true);
    expect(h.store.get('hold-season')).toBe(true);
    expect(h.mult()).toBe(3600);
  });

  it('leaves an already-watchable rate alone', () => {
    const h = wireRung('globe', 3600);
    h.store.set('hold-season', true);
    expect(h.mult()).toBe(3600);
  });

  it('still disengages when the VIEWER picks a fast rate — the guard is not a blanket', () => {
    const h = wireRung('globe', 3600);
    h.store.set('hold-season', true);
    h.store.set('rate', rateId(2.6e6));
    expect(h.store.get('hold-season')).toBe(false);
    expect(h.seasonPinnedTo()).toBe(false);
  });
});
