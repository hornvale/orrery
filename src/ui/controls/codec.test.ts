import { describe, expect, it } from 'vitest';
import type { Control } from './kinds';
import { decodeControls, encodeControls } from './codec';

const CONTROLS: Control[] = [
  { kind: 'toggle', id: 'winds', label: 'winds', group: 'layers', default: false, apply: () => {} },
  { kind: 'toggle', id: 'glint', label: 'glint', group: 'look', default: true, apply: () => {} },
  { kind: 'choice', id: 'look', label: 'Look', group: 'look',
    options: [{ id: 'natural', label: 'natural' }, { id: 'dither3d', label: 'dither3d' }],
    default: 'natural', apply: () => {} },
  { kind: 'slider', id: 'dot-scale', label: 'dot scale', group: 'look',
    min: 0.5, max: 4, step: 0.1, default: 1, apply: () => {} },
  { kind: 'action', id: 'reroll', label: 'reroll', group: 'world', run: () => {} },
];

describe('the control codec', () => {
  it('encodes nothing when everything is at its default', () => {
    expect(encodeControls({})).toBe('');
  });

  it('round-trips a mixed set', () => {
    const values = { winds: true, glint: false, look: 'dither3d', 'dot-scale': 2.5 };
    expect(decodeControls(encodeControls(values), CONTROLS)).toEqual(values);
  });

  it('writes booleans as 1 and 0', () => {
    expect(encodeControls({ winds: true, glint: false })).toBe('winds:1,glint:0');
  });

  it('decodes an empty string to an empty set', () => {
    expect(decodeControls('', CONTROLS)).toEqual({});
  });

  it('ignores an unknown id rather than failing — a renamed control degrades an old link', () => {
    expect(decodeControls('engraving:1,winds:1', CONTROLS)).toEqual({ winds: true });
  });

  it('ignores a malformed pair', () => {
    expect(decodeControls('winds,glint:0', CONTROLS)).toEqual({ glint: false });
  });

  it('clamps a slider value outside its range', () => {
    expect(decodeControls('dot-scale:99', CONTROLS)).toEqual({ 'dot-scale': 4 });
    expect(decodeControls('dot-scale:-5', CONTROLS)).toEqual({ 'dot-scale': 0.5 });
  });

  it('drops a non-numeric slider value', () => {
    expect(decodeControls('dot-scale:huge', CONTROLS)).toEqual({});
  });

  it('drops a choice value that is not one of its options', () => {
    expect(decodeControls('look:watercolor', CONTROLS)).toEqual({});
  });

  it('drops a value for an action, which holds none', () => {
    expect(decodeControls('reroll:1', CONTROLS)).toEqual({});
  });

  it('keeps a shared link short by trimming trailing zeros', () => {
    expect(encodeControls({ 'dot-scale': 2.5 })).toBe('dot-scale:2.5');
    expect(encodeControls({ 'dot-scale': 2 })).toBe('dot-scale:2');
  });
});
