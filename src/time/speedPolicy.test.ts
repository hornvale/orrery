import { describe, expect, it } from 'vitest';
import { SPEED_POLICY, SpeedMemory, clampMult } from './speedPolicy';

describe('speed policy', () => {
  it('system rung defaults to ~1 mo/s and is uncapped', () => {
    expect(SPEED_POLICY.system).toEqual({ defaultMult: 2.6e6, maxMult: null });
  });
  it('globe rung defaults to 1 hr/s and caps at 1 day/s', () => {
    expect(SPEED_POLICY.globe).toEqual({ defaultMult: 3600, maxMult: 86400 });
  });
  it('clamps a blur rate at the globe, passes it at the system', () => {
    expect(clampMult('globe', 2.6e6)).toBe(86400);
    expect(clampMult('system', 2.6e6)).toBe(2.6e6);
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
    mem.remember('globe', 2.6e6);
    expect(mem.restore('globe')).toBe(86400);
  });
});
