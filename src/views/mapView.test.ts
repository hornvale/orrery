import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { createMapView, ISO_CAMERA_DISTANCE, MAP_VOXEL_EXTENT } from "./mapView";
import type { RegionScene } from "../sim/scene";
import type { TileId } from "./cubeSphere";
import { tileKey } from "./cubeSphere";

function fakeRegion(samples = 4): RegionScene {
  const n = (samples + 1) * (samples + 1);
  return {
    schema: "scene/tiles-region/v1",
    seed: 42,
    face: 0,
    level: 3,
    ix: 0,
    iy: 0,
    samples,
    sea_level_m: 0,
    season_period_days: 360,
    circulationBands: 3,
    biomeLegend: ["deep-ocean", "temperate-forest"],
    elevation_m: Array.from({ length: n }, () => 100),
    ocean: Array.from({ length: n }, () => false),
    biome: Array.from({ length: n }, () => 1),
    plate: Array.from({ length: n }, () => 0),
    unrest: Array.from({ length: n }, () => 0),
  } as unknown as RegionScene;
}

test("createMapView returns a scene with an orthographic camera", () => {
  const v = createMapView();
  expect(v.scene).toBeInstanceOf(THREE.Scene);
  expect(v.camera).toBeInstanceOf(THREE.OrthographicCamera);
});

test("setRegion mounts exactly one map mesh; null clears it", () => {
  const v = createMapView();
  const meshCount = () =>
    v.scene.children.filter((c) => c instanceof THREE.Mesh).length;
  expect(meshCount()).toBe(0);
  v.setRegion(fakeRegion());
  expect(meshCount()).toBe(1);
  v.setRegion(fakeRegion(8)); // replacing keeps it at one
  expect(meshCount()).toBe(1);
  v.setRegion(null);
  expect(meshCount()).toBe(0);
});

test("dispose empties the scene", () => {
  const v = createMapView();
  v.setRegion(fakeRegion());
  v.dispose();
  expect(v.scene.children.filter((c) => c instanceof THREE.Mesh).length).toBe(
    0,
  );
});

test("setRegion textures the quad with the region pixel map (pixel style)", () => {
  const v = createMapView();
  v.setStyle("pixel");
  v.setRegion(fakeRegion());
  const mesh = v.scene.children.find(
    (c) => c instanceof THREE.Mesh,
  ) as THREE.Mesh;
  const mat = mesh.material as THREE.MeshBasicMaterial;
  expect(mat.map).not.toBeNull();
  expect(mat.map).toBeInstanceOf(THREE.DataTexture);
});

describe("MapStyle switch (The Diorama)", () => {
  test("default style is voxel: setRegion mounts a voxel diorama, not a plane", () => {
    const v = createMapView();
    v.setRegion(fakeRegion());
    const mesh = v.scene.children.find(
      (c) => c instanceof THREE.Mesh,
    ) as THREE.Mesh;
    expect(mesh.geometry).not.toBeInstanceOf(THREE.PlaneGeometry);
    // A voxel heightfield has far more than a plane's 4 corner vertices
    // (non-indexed, 6 verts/face at minimum for every one of `samples²`
    // cells' top face alone).
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(4);
  });

  test("voxel style sets the fixed-isometric camera pose", () => {
    const v = createMapView();
    v.setRegion(fakeRegion());
    expect(v.camera.position.x).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.camera.position.y).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.camera.position.z).toBeCloseTo(ISO_CAMERA_DISTANCE);
  });

  test("setStyle('pixel') restores the exact pixel plane + top-down camera", () => {
    const v = createMapView();
    v.setRegion(fakeRegion()); // mounted under the default voxel style first
    v.setStyle("pixel");
    const mesh = v.scene.children.find(
      (c) => c instanceof THREE.Mesh,
    ) as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(v.camera.position.toArray()).toEqual([0, 0, 10]);
  });

  test("setStyle('voxel') after pixel restores the isometric pose and voxel mesh", () => {
    const v = createMapView();
    v.setRegion(fakeRegion());
    v.setStyle("pixel");
    v.setStyle("voxel");
    const mesh = v.scene.children.find(
      (c) => c instanceof THREE.Mesh,
    ) as THREE.Mesh;
    expect(mesh.geometry).not.toBeInstanceOf(THREE.PlaneGeometry);
    expect(v.camera.position.toArray()).toEqual([
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
    ]);
  });

  test("setStyle applies the camera pose even with no region mounted", () => {
    const v = createMapView();
    v.setStyle("pixel");
    expect(v.camera.position.toArray()).toEqual([0, 0, 10]);
    v.setStyle("voxel");
    expect(v.camera.position.toArray()).toEqual([
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
    ]);
  });

  test("setRegion(null) clears the mounted mesh under either style", () => {
    const v = createMapView();
    v.setRegion(fakeRegion());
    v.setRegion(null);
    expect(v.scene.children.filter((c) => c instanceof THREE.Mesh).length).toBe(
      0,
    );
    v.setStyle("pixel");
    v.setRegion(fakeRegion());
    v.setRegion(null);
    expect(v.scene.children.filter((c) => c instanceof THREE.Mesh).length).toBe(
      0,
    );
  });
});

describe("neighbor-tile ring (The Excursion)", () => {
  function fakeRegionAt(tile: TileId, samples = 4): RegionScene {
    const n = (samples + 1) * (samples + 1);
    return {
      schema: "scene/tiles-region/v1",
      seed: 42,
      face: tile.face,
      level: tile.level,
      ix: tile.ix,
      iy: tile.iy,
      samples,
      sea_level_m: 0,
      season_period_days: 360,
      circulationBands: 3,
      biomeLegend: ["deep-ocean", "temperate-forest"],
      elevation_m: Array.from({ length: n }, () => 100),
      ocean: Array.from({ length: n }, () => false),
      biome: Array.from({ length: n }, () => 1),
      plate: Array.from({ length: n }, () => 0),
      unrest: Array.from({ length: n }, () => 0),
    } as unknown as RegionScene;
  }

  const CENTER: TileId = { face: 0, level: 3, ix: 4, iy: 4 };

  test("beginRegion requests the full radius-1 ring (9 tiles) eagerly, up front", () => {
    const requested: TileId[] = [];
    const v = createMapView({ requestRegion: (t) => requested.push(t) });
    v.beginRegion(CENTER);
    expect(requested).toHaveLength(9);
    expect(requested.map(tileKey).sort()).toContain(tileKey(CENTER));
  });

  test("onRegion mounts each arriving ring tile at its own offset; only 1 mesh until neighbors arrive", () => {
    const v = createMapView({ requestRegion: () => {} });
    v.beginRegion(CENTER);
    const meshCount = () => v.scene.children.filter((c) => c instanceof THREE.Mesh).length;
    v.onRegion(tileKey(CENTER), fakeRegionAt(CENTER));
    expect(meshCount()).toBe(1);
    const east: TileId = { face: 0, level: 3, ix: 5, iy: 4 };
    v.onRegion(tileKey(east), fakeRegionAt(east));
    expect(meshCount()).toBe(2);
  });

  test("mounted ring tiles sit at distinct world positions, offset by tile extent", () => {
    const v = createMapView({ requestRegion: () => {} });
    v.beginRegion(CENTER);
    v.onRegion(tileKey(CENTER), fakeRegionAt(CENTER));
    const east: TileId = { face: 0, level: 3, ix: 5, iy: 4 };
    v.onRegion(tileKey(east), fakeRegionAt(east));
    const meshes = v.scene.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const xs = meshes.map((m) => m.position.x).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(MAP_VOXEL_EXTENT);
  });

  test("a reply for a tile outside the current halo is dropped, not mounted or cached", () => {
    const v = createMapView({ requestRegion: () => {} });
    v.beginRegion(CENTER);
    const meshCount = () => v.scene.children.filter((c) => c instanceof THREE.Mesh).length;
    const farAway: TileId = { face: 0, level: 3, ix: 4, iy: 7 }; // 3 tiles away > halo radius 2
    v.onRegion(tileKey(farAway), fakeRegionAt(farAway));
    expect(meshCount()).toBe(0);
  });

  test("a genuine region change (beginRegion again) clears every previously mounted tile", () => {
    const v = createMapView({ requestRegion: () => {} });
    v.beginRegion(CENTER);
    v.onRegion(tileKey(CENTER), fakeRegionAt(CENTER));
    expect(v.scene.children.filter((c) => c instanceof THREE.Mesh)).toHaveLength(1);
    const elsewhere: TileId = { face: 2, level: 3, ix: 1, iy: 1 };
    v.beginRegion(elsewhere);
    expect(v.scene.children.filter((c) => c instanceof THREE.Mesh)).toHaveLength(0);
    v.onRegion(tileKey(elsewhere), fakeRegionAt(elsewhere));
    expect(v.scene.children.filter((c) => c instanceof THREE.Mesh)).toHaveLength(1);
  });

  test("setStyle rebuilds every currently-mounted ring tile from cache, no new requests", () => {
    const requested: TileId[] = [];
    const v = createMapView({ requestRegion: (t) => requested.push(t) });
    v.beginRegion(CENTER);
    const east: TileId = { face: 0, level: 3, ix: 5, iy: 4 };
    v.onRegion(tileKey(CENTER), fakeRegionAt(CENTER));
    v.onRegion(tileKey(east), fakeRegionAt(east));
    const requestedBefore = requested.length;
    v.setStyle("pixel");
    expect(requested.length).toBe(requestedBefore); // no new fetches
    const meshes = v.scene.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(meshes).toHaveLength(2);
    expect(meshes.every((m) => m.geometry instanceof THREE.PlaneGeometry)).toBe(true);
  });

  test("only the center tile carries the symbol overlay, never a neighbor", () => {
    const v = createMapView({ requestRegion: () => {} });
    v.setStyle("pixel");
    v.beginRegion(CENTER);
    v.onRegion(tileKey(CENTER), fakeRegionAt(CENTER));
    const east: TileId = { face: 0, level: 3, ix: 5, iy: 4 };
    v.onRegion(tileKey(east), fakeRegionAt(east));
    const symbolGroups = v.scene.children.filter((c) => c.name === "map-symbols");
    expect(symbolGroups).toHaveLength(1);
  });
});
