import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { createMapView, ISO_CAMERA_DISTANCE } from "./mapView";
import type { RegionScene } from "../sim/scene";

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
