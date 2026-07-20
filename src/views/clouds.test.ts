import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLOUD_TEX_H, CLOUD_TEX_W } from './cloudTexture';
import { DRIFT_RATE, SHELL_HEADROOM, createClouds } from './clouds';
import type { TilesScene } from '../sim/scene';

/** A minimal `TilesScene` fixture: only the fields `createClouds`/
 * `cloudTextureData` actually read (`width`, `height`, `cloudType`,
 * `weatherPropensity`) — additive filler for whatever a future field needs,
 * mirroring the pre-shell fixture's `as never` cast convention. */
function tilesFixture(opts: { width: number; height: number; cloudType: number[]; weatherPropensity?: number[] }): TilesScene {
  return {
    width: opts.width,
    height: opts.height,
    cloudType: opts.cloudType,
    weatherPropensity: opts.weatherPropensity ?? opts.cloudType.map(() => 0.5),
  } as never;
}

describe('createClouds', () => {
  it('returns null when every tile reads cloudType 0 (an all-clear-sky document)', () => {
    const tiles = tilesFixture({ width: 4, height: 2, cloudType: Array(8).fill(0) });
    expect(createClouds(tiles, 1)).toBeNull();
  });

  it('builds a textured sphere shell when at least one tile carries a cloud type', () => {
    const tiles = tilesFixture({ width: 4, height: 2, cloudType: [2, 0, 0, 0, 0, 0, 0, 0] });
    const clouds = createClouds(tiles, 1)!;
    expect(clouds).not.toBeNull();
    const mesh = clouds.object3d as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry).toBeInstanceOf(THREE.SphereGeometry);
  });

  it('the material is transparent and carries a DataTexture sized CLOUD_TEX_W x CLOUD_TEX_H', () => {
    const tiles = tilesFixture({ width: 4, height: 2, cloudType: [1, 0, 0, 0, 0, 0, 0, 0] });
    const clouds = createClouds(tiles, 1)!;
    const mesh = clouds.object3d as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.transparent).toBe(true);
    const texture = material.map as THREE.DataTexture;
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(CLOUD_TEX_W);
    expect(texture.image.height).toBe(CLOUD_TEX_H);
    expect(texture.image.data.length).toBe(CLOUD_TEX_W * CLOUD_TEX_H * 4);
  });

  it('sits above the sphere by SHELL_HEADROOM so relief cannot swallow it', () => {
    const tiles = tilesFixture({ width: 2, height: 1, cloudType: [3, 0] });
    const clouds = createClouds(tiles, 10)!;
    const mesh = clouds.object3d as THREE.Mesh;
    const geom = mesh.geometry as THREE.SphereGeometry;
    expect(geom.parameters.radius).toBeCloseTo(10 * (1 + SHELL_HEADROOM), 10);
  });

  it('starts hidden', () => {
    const tiles = tilesFixture({ width: 2, height: 1, cloudType: [1, 0] });
    expect(createClouds(tiles, 1)!.object3d.visible).toBe(false);
  });

  it('shows and hides', () => {
    const tiles = tilesFixture({ width: 2, height: 1, cloudType: [1, 0] });
    const clouds = createClouds(tiles, 1)!;
    clouds.setVisible(true);
    expect(clouds.object3d.visible).toBe(true);
    clouds.setVisible(false);
    expect(clouds.object3d.visible).toBe(false);
  });

  it('update(day) advances the texture longitude offset (drift), never re-deriving the texture', () => {
    const tiles = tilesFixture({ width: 4, height: 2, cloudType: [4, 0, 0, 0, 0, 0, 0, 0] });
    const clouds = createClouds(tiles, 1)!;
    const mesh = clouds.object3d as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    const texture = material.map as THREE.DataTexture;
    const originalData = texture.image.data;
    const originalSnapshot = Uint8ClampedArray.from(originalData);

    clouds.update(0);
    const offsetAtZero = texture.offset.x;

    clouds.update(10);
    const offsetAtTen = texture.offset.x;

    expect(offsetAtTen).not.toBeCloseTo(offsetAtZero, 10);
    expect(offsetAtTen).toBeCloseTo(((10 * DRIFT_RATE) % 1), 10);
    // No per-day regeneration: same array instance, same contents.
    expect(texture.image.data).toBe(originalData);
    expect(Array.from(texture.image.data)).toEqual(Array.from(originalSnapshot));
  });

  it('drift wraps within [0, 1) for a large day value', () => {
    const tiles = tilesFixture({ width: 2, height: 1, cloudType: [5, 0] });
    const clouds = createClouds(tiles, 1)!;
    const mesh = clouds.object3d as THREE.Mesh;
    const texture = (mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    clouds.update(100000);
    expect(texture.offset.x).toBeGreaterThanOrEqual(0);
    expect(texture.offset.x).toBeLessThan(1);
  });
});
