import { describe, expect, test } from "vitest";
import * as THREE from "three";
import {
  createMapView,
  ISO_CAMERA_DISTANCE,
  MAP_RING_RADIUS,
  MAP_VOXEL_EXTENT,
  tileOffsetForWorldPoint,
  worldPointForTileOffset,
} from "./mapView";
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
    // Final-review fix: setStyle now re-syncs controls.target and calls
    // controls.update() (a fresh region's center offset is (0, 0), so the
    // target itself is exactly (0, 0, 0) — see the target assertion below);
    // update()'s internal spherical round-trip introduces a few ULPs of
    // floating-point noise into camera.position even when it's
    // mathematically a no-op, so this compares component-wise with
    // toBeCloseTo (matching "voxel style sets the fixed-isometric camera
    // pose", above) instead of an exact array toEqual.
    expect(v.camera.position.x).toBeCloseTo(0);
    expect(v.camera.position.y).toBeCloseTo(0);
    expect(v.camera.position.z).toBeCloseTo(10);
    expect(v.controls.target.toArray()).toEqual([0, 0, 0]);
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
    // See the toBeCloseTo comment above — same controls.update() ULP noise.
    expect(v.camera.position.x).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.camera.position.y).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.camera.position.z).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.controls.target.toArray()).toEqual([0, 0, 0]);
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
  // Local to this describe block, same shape as the sibling "neighbor-tile
  // ring" describe's own `fakeRegionAt` (that one is scoped to its own
  // block, not reachable here).
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

    // Recenter: moving solidly past a tile boundary on Z triggers a
    // recenter, mirroring "panning solidly past a tile boundary triggers a
    // recenter" above but on Z instead of X. Since The Selvage, voxel's +dy
    // runs toward +z, so a negative-Z target recenters toward iy-1 — the
    // direction is not what this test is about, only that one happens.
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

  // Final-review fix: `controls.target` persists across `setStyle`/
  // `beginRegion`/`setRegion` calls (it's a `THREE.Vector3` the view never
  // recreates), so a pan from a PRIOR visit/style could leak into the next
  // one unless each of these three explicitly re-anchors it.
  test("a fresh beginRegion re-anchors controls.target to the origin, not wherever a prior pan left it", () => {
    const v = createMapView({ requestRegion: () => {} });
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    v.beginRegion(center);
    // Pan away from the origin within this visit.
    v.controls.target.set(0.8 * MAP_VOXEL_EXTENT, 0, 0.4 * MAP_VOXEL_EXTENT);
    // A fresh visit to a new region (e.g. re-entering the Map view) must not
    // inherit that stale pan.
    const elsewhere: TileId = { face: 2, level: 3, ix: 1, iy: 1 };
    v.beginRegion(elsewhere);
    expect(v.controls.target.toArray()).toEqual([0, 0, 0]);
  });

  test("setStyle re-anchors controls.target to the current center's world point under the new style's axis convention", () => {
    const v = createMapView({ requestRegion: () => {} });
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    v.beginRegion(center);
    v.onRegion(tileKey(center), fakeRegionAt(center));
    // Recenter one tile east AND one tile "south" (+dx, +dy) by panning
    // solidly past both boundaries at once — a nonzero dy is essential here:
    // it's the axis pixel and voxel disagree on (Y vs Z, with the same
    // negation), so a dx-only recenter can't distinguish "re-anchored
    // correctly" from "leftover on the wrong axis".
    v.controls.target.set(0.7 * MAP_VOXEL_EXTENT, 0, 0.7 * MAP_VOXEL_EXTENT);
    v.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    const recentered: TileId = { face: 0, level: 3, ix: 5, iy: 5 };
    v.onRegion(tileKey(recentered), fakeRegionAt(recentered));

    // Switching style must re-anchor target to the recentered tile's offset
    // (dx=1, dy=1) under the NEW style's axis convention — Y for pixel, Z
    // for voxel — not leave it at the old style's raw (stale, mid-pan)
    // coordinates, and not leave the OFF-plane axis contaminated with a
    // leftover value from before the switch.
    v.setStyle("pixel");
    expect(v.controls.target.toArray()).toEqual([1 * MAP_VOXEL_EXTENT, -1 * MAP_VOXEL_EXTENT, 0]);

    v.setStyle("voxel");
    expect(v.controls.target.toArray()).toEqual([1 * MAP_VOXEL_EXTENT, 0, 1 * MAP_VOXEL_EXTENT]);
  });

  // Final-review fix, round 2: the FIRST fix above re-anchored
  // `controls.target` but left `camera.position` at the origin-assuming pose
  // `applyIsoCamera`/`applyPixelCamera` had just hard-set — looking at the
  // right target from the WRONG position (still offset from the origin, not
  // the recentered target), which shears the view off-axis. This test would
  // have passed under that incomplete fix (target moved correctly) but must
  // fail unless `camera.position` ALSO moved by the same offset.
  test("setStyle also translates camera.position by the same offset as controls.target, keeping the iso/straight-down pose anchored on the new target", () => {
    const v = createMapView({ requestRegion: () => {} });
    const center: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    v.beginRegion(center);
    v.onRegion(tileKey(center), fakeRegionAt(center));
    // Recenter one tile east AND one tile "south" (dx=1, dy=1) — same
    // maneuver as the controls.target re-anchor test above.
    v.controls.target.set(0.7 * MAP_VOXEL_EXTENT, 0, 0.7 * MAP_VOXEL_EXTENT);
    v.render({ render: () => {} } as unknown as THREE.WebGLRenderer);
    const recentered: TileId = { face: 0, level: 3, ix: 5, iy: 5 };
    v.onRegion(tileKey(recentered), fakeRegionAt(recentered));

    v.setStyle("pixel");
    // applyPixelCamera hard-sets position to (0, 0, 10), assuming target is
    // at the origin. setStyle must translate it by the SAME (dx=1, dy=1)
    // offset applied to controls.target, so position ends up 10 world units
    // straight "up" from the recentered target — not still hovering over the
    // origin. `controls.update()`'s internal spherical round-trip introduces
    // a few ULPs of floating-point noise even on a mathematical no-op (see
    // "setStyle('pixel') restores the exact pixel plane + top-down camera",
    // above), so this compares component-wise with toBeCloseTo rather than
    // an exact array toEqual.
    expect(v.camera.position.x).toBeCloseTo(1 * MAP_VOXEL_EXTENT);
    expect(v.camera.position.y).toBeCloseTo(-1 * MAP_VOXEL_EXTENT);
    expect(v.camera.position.z).toBeCloseTo(10);
    const pixelOffsetFromTarget = v.camera.position.clone().sub(v.controls.target);
    expect(pixelOffsetFromTarget.x).toBeCloseTo(0);
    expect(pixelOffsetFromTarget.y).toBeCloseTo(0);
    expect(pixelOffsetFromTarget.z).toBeCloseTo(10);

    v.setStyle("voxel");
    // Same requirement for the isometric pose: position stays offset from
    // the (new) target by (d, d, d), the true isometric direction.
    expect(v.camera.position.x).toBeCloseTo(ISO_CAMERA_DISTANCE + 1 * MAP_VOXEL_EXTENT);
    expect(v.camera.position.y).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(v.camera.position.z).toBeCloseTo(ISO_CAMERA_DISTANCE + 1 * MAP_VOXEL_EXTENT);
    const isoOffsetFromTarget = v.camera.position.clone().sub(v.controls.target);
    expect(isoOffsetFromTarget.x).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(isoOffsetFromTarget.y).toBeCloseTo(ISO_CAMERA_DISTANCE);
    expect(isoOffsetFromTarget.z).toBeCloseTo(ISO_CAMERA_DISTANCE);
  });
});

describe("world <-> tile offset mapping (The Selvage)", () => {
  const OFFSETS: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 1],
    [-1, -1],
    [2, -3],
  ];

  // The forward map places meshes and re-anchors `controls.target`; the
  // inverse tells `maybeRecenter` which tile the camera is over. Before The
  // Selvage the inverse was open-coded twice with the sign inlined, so the
  // two could drift apart silently. This is the test that stops that.
  test("tileOffsetForWorldPoint inverts worldPointForTileOffset, both styles", () => {
    for (const style of ["voxel", "pixel"] as const) {
      for (const [dx, dy] of OFFSETS) {
        const [x, y, z] = worldPointForTileOffset(style, dx, dy);
        const back = tileOffsetForWorldPoint(style, x, y, z);
        expect(back.dx).toBeCloseTo(dx);
        expect(back.dy).toBeCloseTo(dy);
      }
    }
  });

  // Each style keeps its own plane: voxel's ground is X–Z (Y is height),
  // pixel's quad is X–Y (Z is depth-only). A mapping that leaked a nonzero
  // value onto the off-plane axis would contaminate `controls.target`.
  test("each style leaves its off-plane axis at zero", () => {
    for (const [dx, dy] of OFFSETS) {
      const [, voxelY] = worldPointForTileOffset("voxel", dx, dy);
      expect(voxelY).toBe(0);
      const [, , pixelZ] = worldPointForTileOffset("pixel", dx, dy);
      expect(pixelZ).toBe(0);
    }
  });

  /** A region whose elevation rises with `row`, so the built geometry has an
   * unambiguous "which end is row N" — the fixture the row-direction
   * assertion below needs. Same shape as the sibling blocks' `fakeRegionAt`. */
  function slopedRegionAt(tile: TileId, samples = 4): RegionScene {
    const n = samples + 1;
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
      // row-major: node (row, col) is row*n + col. Elevation depends only on
      // row, rising by a full band per row so the banding cannot flatten it.
      elevation_m: Array.from({ length: n * n }, (_, i) => Math.floor(i / n) * 1000),
      ocean: Array.from({ length: n * n }, () => false),
      biome: Array.from({ length: n * n }, () => 1),
      plate: Array.from({ length: n * n }, () => 0),
      unrest: Array.from({ length: n * n }, () => 0),
    } as unknown as RegionScene;
  }

  function meshNamed(v: ReturnType<typeof createMapView>, addr: TileId): THREE.Mesh {
    const suffix = `${addr.face}:${addr.level}:${addr.ix}:${addr.iy}`;
    const mesh = v.scene.children.find(
      (c) => c instanceof THREE.Mesh && c.name.endsWith(suffix),
    );
    if (!mesh) throw new Error(`no mounted mesh for ${suffix}`);
    return mesh as THREE.Mesh;
  }

  /** A mesh's world-space Z span: its geometry's own bounding box plus
   * wherever the ring mounted it. */
  function worldZSpan(mesh: THREE.Mesh): { min: number; max: number } {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    return { min: bb.min.z + mesh.position.z, max: bb.max.z + mesh.position.z };
  }

  // Half one of the invariant: WITHIN a tile, increasing `row` must run
  // toward +z under 'voxel'. Asserted through the built geometry (where is
  // the tall end?) rather than by restating cornerZ's formula.
  test("voxel: within a tile, increasing row runs toward +z", () => {
    const addr: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    const v = createMapView({ requestRegion: () => {} });
    v.setRegion(slopedRegionAt(addr));
    const pos = meshNamed(v, addr).geometry.getAttribute("position");
    let tallestZ = 0;
    let tallestY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > tallestY) {
        tallestY = pos.getY(i);
        tallestZ = pos.getZ(i);
      }
    }
    expect(tallestZ).toBeGreaterThan(0);
  });

  // Half two: ACROSS tiles, +dy must run the same way. Together the two
  // halves are the invariant the producer's `param(iy, row/N, level)`
  // imposes — and their disagreement was the seam. Asserted as adjacency of
  // the two meshes' world-space spans, which is what "continuous" means
  // here; a test comparing worldPointForTileOffset to a literal would pass
  // whichever sign happened to be in the file.
  test("voxel: the dy=+1 neighbour abuts the origin tile's +z edge", () => {
    const origin: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    const neighbour: TileId = { face: 0, level: 3, ix: 4, iy: 5 };
    const v = createMapView({ requestRegion: () => {} });
    v.beginRegion(origin);
    v.onRegion(tileKey(origin), slopedRegionAt(origin));
    v.onRegion(tileKey(neighbour), slopedRegionAt(neighbour));
    const originSpan = worldZSpan(meshNamed(v, origin));
    const neighbourSpan = worldZSpan(meshNamed(v, neighbour));
    expect(neighbourSpan.min).toBeCloseTo(originSpan.max);
  });

  // The builder's plinth is opt-in, so the map rung must actually pass
  // floorY — a builder that supports it and a caller that omits it looks
  // exactly like the bug. A flat region emits no walls without a floor and
  // exactly one per boundary cell with one, so vertex count is the tell.
  test("voxel: the map rung mounts tiles WITH a plinth", () => {
    const addr: TileId = { face: 0, level: 3, ix: 4, iy: 4 };
    const samples = 4;
    const v = createMapView({ requestRegion: () => {} });
    v.setRegion(slopedRegionAt(addr, samples));
    const count = meshNamed(v, addr).geometry.getAttribute("position").count;
    // Top faces alone would be samples^2 * 6 vertices; the plinth adds at
    // least one wall quad (6 vertices) per boundary cell.
    expect(count).toBeGreaterThan(samples * samples * 6 + 4 * samples * 6 - 1);
  });
});
