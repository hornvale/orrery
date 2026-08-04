import { describe, expect, it, vi } from 'vitest';
import type { Control } from './kinds';
import { ControlStore } from './store';

function fixture(applied: string[] = []): Control[] {
  return [
    { kind: 'toggle', id: 'winds', label: 'winds', group: 'layers', default: false,
      apply: (v) => { applied.push(`winds:${v}`); } },
    { kind: 'choice', id: 'look', label: 'Look', group: 'look',
      options: [{ id: 'natural', label: 'natural' }, { id: 'voxel', label: 'voxel' }],
      default: 'natural', apply: (v) => { applied.push(`look:${v}`); } },
    { kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
      min: 0.5, max: 4, step: 0.1, default: 1, apply: (v) => { applied.push(`dot:${v}`); } },
    { kind: 'action', id: 'reroll', label: 'reroll', group: 'world', run: () => {} },
  ];
}

describe('ControlStore', () => {
  it('starts every control at its default', () => {
    const store = new ControlStore(fixture());
    expect(store.get('winds')).toBe(false);
    expect(store.get('look')).toBe('natural');
    expect(store.get('dot-scale')).toBe(1);
  });

  it('holds no value for an action', () => {
    const store = new ControlStore(fixture());
    expect(store.get('reroll')).toBeUndefined();
  });

  it('calls the control apply on set', () => {
    const applied: string[] = [];
    const store = new ControlStore(fixture(applied));
    store.set('winds', true);
    expect(applied).toEqual(['winds:true']);
    expect(store.get('winds')).toBe(true);
  });

  it('notifies subscribers with the changed id, and stops after unsubscribe', () => {
    const store = new ControlStore(fixture());
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.set('winds', true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith('winds');
    off();
    store.set('winds', false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('notifies with null on reset, since no single control changed', () => {
    const store = new ControlStore(fixture());
    const seen = vi.fn();
    store.subscribe(seen);
    store.reset();
    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it('reports only the values that differ from their default', () => {
    const store = new ControlStore(fixture());
    expect(store.nonDefaults()).toEqual({});
    store.set('winds', true);
    store.set('dot-scale', 2.5);
    expect(store.nonDefaults()).toEqual({ winds: true, 'dot-scale': 2.5 });
  });

  it('drops a value back out of nonDefaults when it returns to its default', () => {
    const store = new ControlStore(fixture());
    store.set('winds', true);
    store.set('winds', false);
    expect(store.nonDefaults()).toEqual({});
  });

  it('ignores a set for an unknown id rather than throwing', () => {
    const store = new ControlStore(fixture());
    expect(() => store.set('no-such-control', true)).not.toThrow();
    expect(store.get('no-such-control')).toBeUndefined();
  });

  it('reset restores every default and re-applies', () => {
    const applied: string[] = [];
    const store = new ControlStore(fixture(applied));
    store.set('winds', true);
    applied.length = 0;
    store.reset();
    expect(store.get('winds')).toBe(false);
    expect(applied).toContain('winds:false');
  });
});
