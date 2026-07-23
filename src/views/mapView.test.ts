import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { createMapView, ISO_CAMERA_DISTANCE, MAP_RING_RADIUS, MAP_VOXEL_EXTENT } from "./mapView";
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

describe("camera pan/zoom (The Excursion)", () => {
  test("MapControls is attached with rotation disabled", () => {
    const v = createMapView({ requestRegion: () => {} });
    expect(v.controls.enableRotate).toBe(false);
  });

  test("minZoom/maxZoom are set and minZoom < 1 < maxZoom (can zoom both out and in)", () => {
    const v = createMapView({ requestRegion: () => {} });
    expect(v.controls.minZoom).toBeLessThan(1);
    expect(v.controls.maxZoom).toBeGreaterThan(1);
  });

  test("panning the camera target past the ring's edge is clamped on render", () => {
    const v = createMapView({ requestRegion: () => {} });
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    v.beginRegion(center);
    // Push the target way out past any legal ring bound.
    v.controls.target.set(1000, 0, 0);
    v.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    const maxWorldDx = (MAP_RING_RADIUS + 0.5) * MAP_VOXEL_EXTENT;
    expect(Math.abs(v.controls.target.x)).toBeLessThanOrEqual(maxWorldDx);
  });

  test("panning solidly past a tile boundary triggers a recenter (new tile mounts)", () => {
    const requested: TileId[] = [];
    const v = createMapView({ requestRegion: (t) => requested.push(t) });
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    v.beginRegion(center);
    const requestedAfterBegin = requested.length;
    // Move solidly past the +X tile boundary (beyond 0.5 + hysteresis tiles).
    v.controls.target.set(0.7 * MAP_VOXEL_EXTENT, 0, 0);
    v.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    // A recenter re-requests the newly-exposed ring edge — more requests than
    // beginRegion alone issued.
    expect(requested.length).toBeGreaterThan(requestedAfterBegin);
  });

  // `positionAt` maps a tile's second-axis offset `dy` to world `-dy * extent`
  // on whichever axis the active style uses (Z for 'voxel', Y for 'pixel');
  // `clampPan`/`maybeRecenter` undo that same negation on that same axis. The
  // two tests above only ever move `target.x` under the default 'voxel'
  // style, which never exercises that negation or the 'pixel' branch at all.
  test("voxel style: pan clamp and recenter also operate on the world Z axis (second axis)", () => {
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };

    // Clamp: an extreme Z target is pulled back within the ring's bound,
    // mirroring "panning the camera target past the ring's edge is clamped
    // on render" above but on Z instead of X.
    const vClamp = createMapView({ requestRegion: () => {} });
    vClamp.beginRegion(center);
    vClamp.controls.target.set(0, 0, -1000);
    vClamp.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    const maxWorldDz = (MAP_RING_RADIUS + 0.5) * MAP_VOXEL_EXTENT;
    expect(Math.abs(vClamp.controls.target.z)).toBeLessThanOrEqual(maxWorldDz);

    // Recenter: moving solidly past the +Z-mapped tile boundary (the
    // negative-Z direction, since positionAt negates this axis) triggers a
    // recenter, mirroring "panning solidly past a tile boundary triggers a
    // recenter" above but on Z instead of X.
    const requested: TileId[] = [];
    const vRecenter = createMapView({ requestRegion: (t) => requested.push(t) });
    vRecenter.beginRegion(center);
    const requestedAfterBegin = requested.length;
    vRecenter.controls.target.set(0, 0, -0.7 * MAP_VOXEL_EXTENT);
    vRecenter.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    expect(requested.length).toBeGreaterThan(requestedAfterBegin);
  });

  test("pixel style: pan clamp and recenter operate on the world Y axis (second axis)", () => {
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };

    // Clamp, under 'pixel': same shape as the voxel/Z case above, but the
    // second axis is Y (pixel's flat quad is X–Y; see positionAt's doc
    // comment) and the style is switched before the region visit begins.
    const vClamp = createMapView({ requestRegion: () => {} });
    vClamp.setStyle("pixel");
    vClamp.beginRegion(center);
    vClamp.controls.target.set(0, 1000, 0);
    vClamp.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    const maxWorldDy = (MAP_RING_RADIUS + 0.5) * MAP_VOXEL_EXTENT;
    expect(Math.abs(vClamp.controls.target.y)).toBeLessThanOrEqual(maxWorldDy);

    // Recenter, under 'pixel': moving solidly past the Y-mapped tile
    // boundary (negative-Y, same negation convention as voxel's Z) triggers
    // a recenter.
    const requested: TileId[] = [];
    const vRecenter = createMapView({ requestRegion: (t) => requested.push(t) });
    vRecenter.setStyle("pixel");
    vRecenter.beginRegion(center);
    const requestedAfterBegin = requested.length;
    vRecenter.controls.target.set(0, -0.7 * MAP_VOXEL_EXTENT, 0);
    vRecenter.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    expect(requested.length).toBeGreaterThan(requestedAfterBegin);
  });
});
