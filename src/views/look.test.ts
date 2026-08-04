import { describe, expect, it } from 'vitest';
import { LOOKS, ditherSettingControls, lookById, naturalLook } from './look';

describe('the Look roster', () => {
  it('holds exactly the four Looks the Console spec names', () => {
    expect(LOOKS.map((l) => l.id)).toEqual(['natural', 'voxel', 'dither3d', 'pixel']);
  });

  it('gives every Look a unique id', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
  });

  it('resolves a known id', () => {
    expect(lookById('voxel').globeMesh).toBe('voxel');
  });

  it('falls back to natural for an unknown id, so a bad URL never crashes', () => {
    expect(lookById('engraving')).toBe(naturalLook);
  });

  it('gives only the pixel Look a post-process pass', () => {
    for (const look of LOOKS) {
      const passCount = look.postPasses({} as never).length;
      expect(passCount).toBe(look.id === 'pixel' ? 1 : 0);
    }
  });

  it('routes each Look to a legal mesh, surface and map rung', () => {
    for (const look of LOOKS) {
      expect(['smooth', 'voxel']).toContain(look.globeMesh);
      expect(['standard', 'dither']).toContain(look.globeSurface);
      expect(['voxel', 'pixel']).toContain(look.mapRung);
    }
  });
});

describe('the dither Looks settings', () => {
  it('offers all seven', () => {
    const ids = ditherSettingControls(() => {}).map((c) => c.id);
    expect(ids).toEqual([
      'dither-colour', 'dither-dot-scale', 'dither-contrast',
      'dither-variability', 'dither-stretch', 'dither-invert', 'dither-radial',
    ]);
  });

  it('puts every one in the look group, so they render under the Look picker', () => {
    for (const c of ditherSettingControls(() => {})) expect(c.group).toBe('look');
  });

  it('defaults colour mode to colour, so the lens survives', () => {
    const mode = ditherSettingControls(() => {}).find((c) => c.id === 'dither-colour')!;
    expect(mode.kind).toBe('choice');
    if (mode.kind === 'choice') expect(mode.default).toBe('colour');
  });

  it('reports each change as a partial settings patch', () => {
    const seen: unknown[] = [];
    const controls = ditherSettingControls((s) => seen.push(s));
    const dot = controls.find((c) => c.id === 'dither-dot-scale')!;
    if (dot.kind === 'slider') dot.apply(2.5);
    expect(seen).toEqual([{ dotScale: 2.5 }]);
  });

  // These are "not applicable when another Look is active", not "broken" —
  // nothing about the world is wrong when dither3d isn't selected, so they
  // gate via `applies` (hidden outright) rather than `available` (rendered
  // disabled with a reason).
  it('gates every dither setting on the active Look via applies, not available', () => {
    for (const c of ditherSettingControls(() => {})) {
      expect(c.applies, `${c.id} should gate via applies`).toBeTypeOf('function');
      expect(c.available, `${c.id} should not also gate via available`).toBeUndefined();
      expect(c.applies!({ rung: 'globe', tiles: {} as never, lookId: 'dither3d' })).toBe(true);
      expect(c.applies!({ rung: 'globe', tiles: {} as never, lookId: 'natural' })).toBe(false);
    }
  });
});
