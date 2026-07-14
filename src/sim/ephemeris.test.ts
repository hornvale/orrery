import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSystem } from './scene';
import { moonPhase, rotationPhase, synodicDays, worldPhase } from './ephemeris';

// The orrery's Deno suite read this system document from the hornvale
// monorepo's book/src/gallery/scene-system-seed-42.json (a sibling
// directory that doesn't exist in this standalone repo). Inlined verbatim
// here from hornvale commit 32b1311 — it is the exact document the golden
// ephemeris-seed-42.json samples below were generated against (its
// year_phase_offset, 0.20941868, matches the t=0 world_phase sample).
const SYSTEM_JSON = JSON.stringify({
  schema: 'scene/system/v1',
  seed: 42,
  star: { class_name: 'yellow dwarf (G)', luminosity_rel: 0.70079542, hz_inner_au: 0.79527848, hz_outer_au: 1.1468753 },
  world: {
    orbit_au: 0.97164647,
    year_days: 368.05357,
    day_length_days: 0.87987998,
    obliquity_deg: 0.95930567,
    year_phase_offset: 0.20941868,
  },
  moons: [
    { sidereal_days: 15.993805, phase_offset: 0.85759808, distance_mm: 307.74439, size_rel: 1.6350803 },
    { sidereal_days: 32.555, phase_offset: 0.25842259, distance_mm: 494.27358, size_rel: 0.69049995 },
  ],
});

const sys = parseSystem(SYSTEM_JSON);
const golden = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../testdata/ephemeris-seed-42.json'), 'utf8'),
) as { samples: { t: number; world_phase: number; rotation_phase: number; moons: number[] }[] };

// The published elements (scene-system) and the golden phases are quantized
// to 8 significant digits for cross-platform byte-identity. Reproducing a
// phase divides elapsed time by a period (rotation: t/day_length ≈ 409× at
// t=360 for seed 42; moons: t/synodic ≈ 20×), which amplifies the elements'
// ~1e-8 quantization granularity into a ~1e-6 phase discrepancy. So this
// cross-language check reproduces the physics to a quantization-aware
// tolerance, not to full float precision — a real formula divergence is off
// by orders of magnitude more and is still caught.
const PHASE_TOLERANCE_DIGITS = 4; // toBeCloseTo digits ⇒ |diff| < 0.5e-4, looser than the 1e-5 Deno tolerance

describe('ephemeris', () => {
  it('reproduces the Rust golden phases', () => {
    for (const row of golden.samples) {
      expect(worldPhase(sys, row.t)).toBeCloseTo(row.world_phase, PHASE_TOLERANCE_DIGITS);
      expect(rotationPhase(sys, row.t)).toBeCloseTo(row.rotation_phase, PHASE_TOLERANCE_DIGITS);
      row.moons.forEach((p, i) => expect(moonPhase(sys, i, row.t)).toBeCloseTo(p, PHASE_TOLERANCE_DIGITS));
    }
  });

  it('synodicDays computes P·Y/(Y−P) and is null when the moon never laps the sun', () => {
    const fastMoon = { siderealDays: 10, phaseOffset: 0, distanceMm: 1, sizeRel: 1 };
    const slowMoon = { siderealDays: 400, phaseOffset: 0, distanceMm: 1, sizeRel: 1 };
    const equalMoon = { siderealDays: 100, phaseOffset: 0, distanceMm: 1, sizeRel: 1 };
    const withMoons = (moons: (typeof fastMoon)[]) => ({
      ...sys,
      world: { ...sys.world, yearDays: 100 },
      moons,
    });

    expect(synodicDays(withMoons([fastMoon]), 0)!).toBeCloseTo((10 * 100) / (100 - 10), 9);
    expect(synodicDays(withMoons([slowMoon]), 0)).toBeNull();
    expect(synodicDays(withMoons([equalMoon]), 0)).toBeNull();
  });

  it("moonPhase is 0 when the moon's synodic period is null", () => {
    const slowMoon = { siderealDays: 400, phaseOffset: 0.3, distanceMm: 1, sizeRel: 1 };
    const s = { ...sys, world: { ...sys.world, yearDays: 100 }, moons: [slowMoon] };
    expect(moonPhase(s, 0, 42)).toEqual(0);
  });

  it('rotationPhase is 0 for a tidally locked world (day_length_days null)', () => {
    const locked = { ...sys, world: { ...sys.world, dayLengthDays: null } };
    expect(rotationPhase(locked, 12345.6789)).toEqual(0);
  });
});
