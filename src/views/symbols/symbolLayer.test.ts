import { expect, test } from 'vitest';
import * as THREE from 'three';
import { buildSymbolLayer, hash01 } from './symbolLayer';
import type { TilesScene } from '../../sim/scene';

function landWorld(): TilesScene {
  const w = 8, h = 4;
  const elevation_m = Array.from({ length: w * h }, (_, i) => (i === 10 ? 5000 : 100));
  const biome = Array.from({ length: w * h }, () => 1); // all forest
  return {
    schema: 'scene/tiles/v1', width: w, height: h, sea_level_m: 0,
    elevation_m, ocean: elevation_m.map(() => false), biome,
    biomeLegend: ['desert', 'temperate-forest'], plate: [], unrest: [], features: [],
  } as unknown as TilesScene;
}

test('hash01 is deterministic and in range', () => {
  expect(hash01(7)).toBe(hash01(7));
  expect(hash01(7)).toBeGreaterThanOrEqual(0);
  expect(hash01(7)).toBeLessThan(1);
});

test('a near-rung layer mounts more symbols than a far-rung one', () => {
  const layer = buildSymbolLayer(landWorld());
  const cam = new THREE.Vector3(0, 0, 100); // everything on the near side
  layer.update('far', cam);
  const farCount = layer.group.children.length;
  layer.update('near', cam);
  const nearCount = layer.group.children.length;
  expect(nearCount).toBeGreaterThanOrEqual(farCount);
  expect(nearCount).toBeGreaterThan(0);
});

test('symbol positions are stable across identical updates (no shimmer)', () => {
  const layer = buildSymbolLayer(landWorld());
  const cam = new THREE.Vector3(0, 0, 100);
  layer.update('near', cam);
  const first = layer.group.children.map((c) => c.position.toArray().join(','));
  layer.update('near', cam);
  const second = layer.group.children.map((c) => c.position.toArray().join(','));
  expect(second).toEqual(first);
});

test('ocean wave-marks appear on the sea, spaced and budget-capped', () => {
  const w = 20, h = 12;
  const ocean = Array.from({ length: w * h }, () => true); // all sea
  const tiles = {
    schema: 'scene/tiles/v1', width: w, height: h, sea_level_m: 0,
    elevation_m: Array.from({ length: w * h }, () => -1000),
    ocean, biome: Array.from({ length: w * h }, () => 0),
    biomeLegend: ['deep-ocean'], plate: [], unrest: [], features: [],
  } as unknown as TilesScene;
  const layer = buildSymbolLayer(tiles);
  const cam = new THREE.Vector3(0, 0, 100);
  layer.update('near', cam);
  const waves = layer.group.children.filter((c) => c.userData.kind === 'wave');
  expect(waves.length).toBeGreaterThan(0);
  expect(waves.length).toBeLessThanOrEqual(160); // near cap
});
