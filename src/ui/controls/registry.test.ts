import { describe, expect, it, vi } from 'vitest';
import { buildRegistry, rateId, SHEET_TABS, type RegistryDeps } from './registry';
import { LENSES } from '../../views/lens';
import { LOOKS, ditherSettingControls } from '../../views/look';
import type { Control } from './kinds';
import { ControlStore } from './store';
import { encodeControls } from './codec';
import { serializeAppState } from '../../state/url';
import { debounce } from '../../state/debounce';
import { SPEED_POLICY, SpeedMemory, clampMult } from '../../time/speedPolicy';
import type { ZoomTarget } from '../../views/zoom';

/** Every dep is a no-op recorder: the registry test cares about the SHAPE of
 * the control list, not what any apply does.
 *
 * `lookSettings` returns the REAL dither settings, not `[]`. Stubbing it
 * empty is what it was, and it quietly exempted the seven newest controls in
 * the app from every invariant below — unique id, URL-safe id, group has a
 * tab, choice default is one of its own options, slider default is inside its
 * own range. Those are exactly the invariants a hand-written control block is
 * most likely to break, so the guard has to see them: 22 controls here, not
 * 15. (`main.ts` passes the same function, closing over the live material's
 * `setSettings`; only the callback differs, and no invariant here reads it.) */
function deps(): RegistryDeps {
  const nop = () => {};
  return {
    setLens: nop, setLook: nop, setWinds: nop, setCurrents: nop, setClouds: nop,
    setWaves: nop, setGlint: nop, setNightFill: nop, setTrueRelief: nop,
    setTrueDistance: nop, setHoldSpin: nop, setHoldSeason: nop, setRate: nop,
    reroll: nop, share: nop,
    rungDefaultRate: () => 1,
    lookSettings: () => ditherSettingControls(() => {}),
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

  // The tripwire on `deps()` itself. Every invariant above is only worth what
  // its fixture covers, and with `lookSettings: () => []` the fixture covered
  // 15 controls while the app shipped 22 — the seven newest, the dither's
  // own, sat outside the guard built to catch precisely their kind of
  // mistake. This fails the moment that stub comes back, and says why.
  it('feeds the dither Look\'s own settings through the same invariants, so none of them is exempt', () => {
    const registered = new Set(ids(buildRegistry(deps())));
    const settings = ditherSettingControls(() => {});
    expect(settings.length).toBeGreaterThan(0);
    for (const c of settings) {
      expect(registered.has(c.id), `${c.id} is not in the registry the invariants above run over`).toBe(true);
    }
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

  // A static `x1` default for `rate` disagreed with what boot actually
  // applies (the rung's own default rate, restored via `SpeedMemory`) — so
  // every fresh load reported rate as "changed" and every plain link carried
  // an unwanted `c=rate:...`. The fix is a rung-aware default, wired through
  // the same `RegistryDeps` port pattern `available` already uses for
  // rung-dependent behaviour.
  it("tracks the rung's own default rate rather than a fixed x1", () => {
    let mult = 1;
    const rate = buildRegistry({ ...deps(), rungDefaultRate: () => mult }).find((c) => c.id === 'rate')!;
    expect(rate.kind).toBe('choice');
    if (rate.kind !== 'choice') return;
    expect(rate.default).toBe('x1');
    mult = 3600;
    expect(rate.default).toBe('x3600'); // live — reflects the CURRENT rung, not the boot rung
  });

  it('boots with rate already at the rung default, so a fresh session serializes an empty control blob', () => {
    const r = buildRegistry({ ...deps(), rungDefaultRate: () => 2.6e6 });
    const store = new ControlStore(r);
    // Mirrors main.ts's boot-time rate application: `applyRate` writes the
    // picked rate back to the store only when it differs from what's
    // already there. With the default tracking the rung, it never differs.
    const picked = 'x2600000';
    if (store.get('rate') !== picked) store.set('rate', picked);
    expect(store.nonDefaults()).toEqual({});
    const encoded = encodeControls(store.nonDefaults());
    expect(encoded).toBe('');
    expect(serializeAppState({ seed: '42', view: 'system', day: 0, controls: encoded })).toBe('#seed=42');
  });

  // The two tests above prove the getter is live under a directly-mocked
  // `rungDefaultRate`, and that the boot-time picker write-back is a no-op —
  // but not that main.ts's ACTUAL rung-switch coupling (`view` reassigned,
  // then `applyRate` re-run, remembered per-rung by `SpeedMemory`) leaves
  // `nonDefaults()` empty too. `main.ts` isn't importable, so this rebuilds
  // that coupling the same way `speedPolicy.test.ts`'s `wireRung` rebuilds
  // the day-hold coupling: the REAL registry, a REAL store, and the REAL
  // `SpeedMemory`/`clampMult`/`SPEED_POLICY`, with only the view handles
  // stubbed out.
  it('stays empty across a real rung switch — the assembled view+applyRate+SpeedMemory coupling, not a mocked default', () => {
    let view: ZoomTarget = 'system';
    const speedMemory = new SpeedMemory();
    let store!: ControlStore;

    function applyRate(mult: number): number {
      const clamped = clampMult(view, mult);
      speedMemory.remember(view, clamped);
      const picked = rateId(clamped);
      if (store.get('rate') !== picked) store.set('rate', picked);
      return clamped;
    }

    const r = buildRegistry({
      ...deps(),
      setRate: (mult) => { applyRate(mult); },
      rungDefaultRate: () => SPEED_POLICY[view].defaultMult,
    });
    store = new ControlStore(r);

    // Boot on the system rung.
    applyRate(speedMemory.restore(view));
    expect(store.nonDefaults()).toEqual({});

    // applyView's own two steps: reassign `view`, THEN re-apply the rate —
    // exactly what a rung switch does in main.ts.
    view = 'globe';
    applyRate(speedMemory.restore(view));
    expect(store.nonDefaults()).toEqual({}); // globe's own default, not a stale system one

    // ...and back, so the round trip is proven too.
    view = 'system';
    applyRate(speedMemory.restore(view));
    expect(store.nonDefaults()).toEqual({});
  });

  // Stage 5 adds the registry's first sliders, whose `input` event fires
  // `store.set` on every drag tick. `main.ts`'s persistence subscriber must
  // be debounced on that side (not the control's own `apply`, which still
  // has to repaint at full rate) or a two-second drag at 60fps clears
  // Safari's ~100-`history.replaceState`-calls-per-30s limit easily.
  it('debouncing the persistence subscriber collapses a drag-style burst of store.set into one write, landing the final value', () => {
    vi.useFakeTimers();
    const r = buildRegistry(deps());
    const store = new ControlStore(r);
    const writes: string[] = [];
    const persist = debounce(() => writes.push(encodeControls(store.nonDefaults())), 250);
    store.subscribe(persist);

    // Stands in for a slider's rapid `input` events (no slider is registered
    // yet — Stage 5 adds the first ones) — toggling back and forth 30 times,
    // ending on the value the "drag" actually settles at.
    for (let i = 0; i < 30; i++) store.set('winds', i % 2 === 0);
    store.set('winds', true);
    expect(writes).toHaveLength(0); // still inside the quiet window — nothing has landed yet

    vi.advanceTimersByTime(250);
    expect(writes).toHaveLength(1); // 31 sets, ONE persistence write
    expect(writes[0]).toBe('winds:1'); // and it is the FINAL value, not the first or a stale one
    vi.useRealTimers();
  });

  // The other half of that debounce. Trailing-edge means the last write is
  // still only SCHEDULED for 250 ms, so closing or reloading inside the
  // window drops it — the viewer's setting is silently gone next load, which
  // is a regression against the synchronous persist this replaced and the
  // COMMON case now that the dither ships seven sliders (let go of the drag,
  // close the tab). `main.ts` is not importable, so — same precedent as the
  // rung-switch test above — this rebuilds its two lines of wiring
  // (`store.subscribe(persist)` plus a `pagehide` listener calling
  // `persist.flush()`) over the REAL registry, store and codec.
  it('flushes the pending write on pagehide, so closing inside the debounce window does not lose the last setting', () => {
    vi.useFakeTimers();
    const r = buildRegistry(deps());
    const store = new ControlStore(r);
    const writes: string[] = [];
    const persist = debounce(() => writes.push(encodeControls(store.nonDefaults())), 250);
    store.subscribe(persist);
    const onPagehide = (): void => { persist.flush(); };
    window.addEventListener('pagehide', onPagehide);
    try {
      store.set('dither-dot-scale', 2.5); // a slider drag settling
      expect(writes).toHaveLength(0); // scheduled, not written — this is what a close would lose

      window.dispatchEvent(new Event('pagehide'));
      expect(writes).toEqual(['dither-dot-scale:2.5']); // landed, with the settled value

      vi.advanceTimersByTime(250);
      expect(writes).toHaveLength(1); // and exactly once — the flush cleared the timer
    } finally {
      window.removeEventListener('pagehide', onPagehide);
      vi.useRealTimers();
    }
  });
});
