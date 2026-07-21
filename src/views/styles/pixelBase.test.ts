import { expect, test } from 'vitest';
import { pixelBaseTreatment, PIXEL_STEP } from './pixelBase';
import type { TilesScene } from '../../sim/scene';

const src = { ocean: [true, false] } as unknown as TilesScene;

test('an ocean tile stays blue-dominant (never takes a land colour)', () => {
  // feed a LAND-green input; the treatment must not let ocean read green
  const [r, g, b] = pixelBaseTreatment.transform([80, 140, 70], src, 0);
  expect(b).toBeGreaterThan(r);
  expect(b).toBeGreaterThan(g);
});

test('a land tile with no biome data falls back to the quantized lens hue', () => {
  const [r, g, b] = pixelBaseTreatment.transform([80, 140, 70], src, 1);
  expect(g).toBeGreaterThan(b); // green land stays green-dominant
  for (const c of [r, g, b]) expect(c % PIXEL_STEP === 0 || c === 255).toBe(true);
});

test('curated biome palette: ice stays legible (not a white blob), forest is green', () => {
  const world = {
    ocean: [false, false],
    biome: [0, 1],
    biomeLegend: ['ice', 'temperate-forest'],
  } as unknown as TilesScene;
  const ice = pixelBaseTreatment.transform([0, 0, 0], world, 0);
  expect(ice[0] > 240 && ice[1] > 240 && ice[2] > 240).toBe(false); // never near-white
  const forest = pixelBaseTreatment.transform([0, 0, 0], world, 1);
  expect(forest[1]).toBeGreaterThan(forest[0]); // green-dominant
  expect(forest[1]).toBeGreaterThan(forest[2]);
});

test('ocean is depth-toned: deep is a darker blue than shallow', () => {
  const world = { ocean: [true, true], elevation_m: [-3000, -100], sea_level_m: 0 } as unknown as TilesScene;
  const deep = pixelBaseTreatment.transform([0, 0, 0], world, 0);
  const shallow = pixelBaseTreatment.transform([0, 0, 0], world, 1);
  expect(deep[2]).toBeGreaterThan(deep[0]); // blue-dominant
  expect(shallow[2]).toBeGreaterThan(deep[2]); // shallow is a lighter blue
});
