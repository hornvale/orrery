import { describe, expect, it } from 'vitest';
import { LOOKS, lookById, naturalLook } from './look';

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
