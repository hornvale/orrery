/** The map view: the region rung below the globe (orrery's newest zoom
 * rung) — a self-contained 2D-orthographic three.js scene showing one
 * region under a `MapStyle` switch (campaign "The Diorama"): either the
 * original flat pixel-art quad (`./mapTexture`, `./mapSymbols`) or a
 * Voxel-2.5D relief diorama (`./worldMesh`'s `buildVoxelHeightfieldGeometry`)
 * under a fixed-isometric camera. A later task wires this view into the
 * app's render loop and zoom ladder (Task 4), driving the symbol rung from
 * the map camera's zoom instead of the fixed `'near'` used under `'pixel'`
 * here. */
import * as THREE from "three";
import type { RegionScene } from "../sim/scene";
import { regionPixelTexture } from "./mapTexture";
import type { MapSymbols } from "./mapSymbols";
import { buildMapSymbols } from "./mapSymbols";
import { buildVoxelHeightfieldGeometry } from "./worldMesh";
import { pixelColorFor } from "./styles/pixelBase";

/** Half-extent of the PIXEL style's orthographic frustum (world units) —
 * unchanged from the original flat map: the camera frames a roughly
 * unit-sized area centered on the origin, matching the unit quad `setRegion`
 * mounts under `'pixel'`. */
const FRUSTUM_HALF_EXTENT = 1;

/** The map's two rungs (campaign "The Diorama"): `'voxel'`, a relief
 * diorama of extruded blocks under a fixed-isometric camera, or `'pixel'`,
 * the original flat pixel-art quad under a top-down camera. A style
 * switches geometry + camera only — both read the SAME per-node color
 * (`pixelColorFor`, below), so Style ⟂ Lens holds: no style special-cases a
 * color. */
export type MapStyle = "voxel" | "pixel";

/** The voxel diorama's footprint (world units, X–Z span) — the same
 * numeric size as the pixel plane's own `2 * FRUSTUM_HALF_EXTENT`, so
 * switching styles doesn't change how much of the region is on screen. Not
 * shared as one constant with the pixel path's literal (kept verbatim,
 * below) so the two styles stay independently readable and tunable. */
export const MAP_VOXEL_EXTENT = 2 * FRUSTUM_HALF_EXTENT;

/** Elevation-band size (m) the voxel diorama quantizes to before scaling to
 * world height — the same value the globe's Terraced/Voxel styles use
 * (`globe.ts`'s private `TERRACE_BAND_M`/`VOXEL_BAND_M`), so a step reads as
 * "one band" the same way on both rungs. Kept as its own local constant
 * (not imported from `globe.ts`) to avoid a view-to-view coupling for what's
 * a shared visual convention, not a shared dependency. */
export const MAP_VOXEL_BAND_M = 250;

/** World-height per meter of banded elevation. Follows the same
 * displacement-fraction formula the globe uses for its own relief
 * (`heightScale * banded / REFERENCE_RADIUS_M`, see `buildVoxelHeightfieldGeometry`'s
 * doc comment), scaled to `globe.ts`'s own `GLOBE_RADIUS * RELIEF_EXAGGERATION`
 * (`2 * 60`) so a given elevation band displaces by a comparable WORLD
 * distance on both the globe and the flat diorama. A first-pass value —
 * the tuning knob for the campaign's mandatory visual framing pass
 * (Task 4). */
export const MAP_VOXEL_HEIGHT_SCALE = 120;

/** True isometric camera offset: elevation `atan(1/√2) ≈ 35.264°`, azimuth
 * 45°. Positioning the camera at `(d, d, d)` looking at the origin with
 * `up = (0, 1, 0)` produces exactly this angle with no separate trig — the
 * symmetric offset over all three axes IS the isometric pose. `d` (world
 * units) only needs to clear the diorama's bounding radius; under an
 * ORTHOGRAPHIC camera it does not affect the apparent (projected) size —
 * that's `ISO_FRUSTUM_HALF_EXTENT`, below. */
export const ISO_CAMERA_DISTANCE = 5;

/** Half-extent of the voxel style's orthographic frustum. A flat
 * `[-E, E]²` footprint (`E = MAP_VOXEL_EXTENT / 2`) viewed from a true
 * isometric direction projects to a silhouette whose widest span is the
 * footprint's diagonal, `E * √2` (the `x - z` extreme at opposite corners);
 * this constant adds margin above that for the blocks' own height plus a
 * comfortable visual border. First-pass value — the campaign's mandatory
 * visual pass (Task 4) is the tuning step if the diorama still clips or
 * floats too small/large in frame. */
export const ISO_FRUSTUM_HALF_EXTENT = 1.8;

/** Near/far planes for the isometric camera — generous around
 * `ISO_CAMERA_DISTANCE`'s distance to the origin (`d * √3`) so the
 * diorama's full depth along the view axis is never clipped. */
const ISO_NEAR = 0.1;
const ISO_FAR = 100;

/** Directional "sun" for the voxel diorama: mostly overhead with a slight
 * tilt (rather than straight down) so top faces (normal `(0,1,0)`) catch
 * more light than the vertical cliff walls (`buildVoxelHeightfieldGeometry`'s
 * outward-facing wall normals) — the Lambertian dot product with a
 * mostly-+Y direction favors +Y-facing faces, which is what makes a stepped
 * relief read as blocks stacked on a table rather than a flat wash. Warm
 * tone matches the globe's own sun light (`globe.ts`'s `light`). */
const VOXEL_LIGHT_COLOR = 0xfff4e0;
const VOXEL_LIGHT_INTENSITY = 1.8;
const VOXEL_LIGHT_POSITION: readonly [number, number, number] = [1, 3, 1.5];

/** Ambient fill so the darkened cliff walls (`VOXEL_CLIFF_DARKEN`) never
 * fall to pure black under the single directional light above. */
const VOXEL_AMBIENT_INTENSITY = 0.55;

/** The map view's public surface: a mountable scene graph plus the per-frame
 * driver a caller (the app's render loop, Task 4) needs. */
export interface MapView {
  /** The map's scene root — render this with `camera` via `render`. */
  scene: THREE.Scene;
  /** The map's shared camera. Under `'pixel'` it looks down the +z axis at
   * the origin; under `'voxel'` it sits at the fixed isometric offset. */
  camera: THREE.OrthographicCamera;
  /** Show `region` under the active `MapStyle`; `null` clears it. Replaces
   * any prior region's mesh, so the scene never carries more than one
   * mounted map mesh at a time. */
  setRegion(region: RegionScene | null): void;
  /** Switch the active style: swaps the camera pose immediately, and — if a
   * region is currently mounted — rebuilds its mesh under the new style (a
   * full rebuild; the map is a static snapshot, not a per-frame repaint).
   * Default is `'voxel'`. */
  setStyle(style: MapStyle): void;
  /** Render this view with the shared renderer. */
  render(renderer: THREE.WebGLRenderer): void;
  /** Dispose the mounted mesh's geometry and material, and empty the scene. */
  dispose(): void;
}

/** Build the map view: an orthographic scene, already posed for the default
 * `'voxel'` style, ready to mount a region via `setRegion`. */
export function createMapView(): MapView {
  const scene = new THREE.Scene();
  scene.name = "map-root";

  const camera = new THREE.OrthographicCamera(
    -FRUSTUM_HALF_EXTENT,
    FRUSTUM_HALF_EXTENT,
    FRUSTUM_HALF_EXTENT,
    -FRUSTUM_HALF_EXTENT,
    0.1,
    100,
  );

  // The voxel diorama's light rig: mounted unconditionally. The pixel
  // style's `MeshBasicMaterial` ignores lights entirely, so leaving these in
  // the scene under `'pixel'` is harmless — this avoids managing light
  // membership as a THIRD thing (on top of the mesh and camera) `setStyle`
  // has to swap.
  const light = new THREE.DirectionalLight(
    VOXEL_LIGHT_COLOR,
    VOXEL_LIGHT_INTENSITY,
  );
  light.position.set(...VOXEL_LIGHT_POSITION);
  light.target.position.set(0, 0, 0);
  scene.add(light);
  scene.add(light.target);
  const ambient = new THREE.AmbientLight(0xffffff, VOXEL_AMBIENT_INTENSITY);
  scene.add(ambient);

  let mesh: THREE.Mesh | null = null;
  let symbols: MapSymbols | null = null;
  let activeStyle: MapStyle = "voxel";
  let currentRegion: RegionScene | null = null;

  /** The `'pixel'` style's camera pose — today's exact top-down setup,
   * verbatim. */
  function applyPixelCamera(): void {
    camera.left = -FRUSTUM_HALF_EXTENT;
    camera.right = FRUSTUM_HALF_EXTENT;
    camera.top = FRUSTUM_HALF_EXTENT;
    camera.bottom = -FRUSTUM_HALF_EXTENT;
    camera.near = 0.1;
    camera.far = 100;
    camera.position.set(0, 0, 10);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  /** The `'voxel'` style's fixed-isometric camera pose (see
   * `ISO_CAMERA_DISTANCE`'s doc comment for why `(d, d, d)` IS the
   * isometric angle). */
  function applyIsoCamera(): void {
    camera.left = -ISO_FRUSTUM_HALF_EXTENT;
    camera.right = ISO_FRUSTUM_HALF_EXTENT;
    camera.top = ISO_FRUSTUM_HALF_EXTENT;
    camera.bottom = -ISO_FRUSTUM_HALF_EXTENT;
    camera.near = ISO_NEAR;
    camera.far = ISO_FAR;
    camera.position.set(
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
      ISO_CAMERA_DISTANCE,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  applyIsoCamera(); // default style is 'voxel'

  function clearMesh(): void {
    if (symbols) {
      scene.remove(symbols.group);
      symbols.dispose();
      symbols = null;
    }
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh = null;
  }

  /** `'pixel'`: today's exact path, verbatim — a flat quad textured with
   * `regionPixelTexture`, plus the symbol overlay. */
  function mountPixel(region: RegionScene): void {
    // Regions are square face-tiles (same sample count on both axes), so a
    // unit square reads at the right aspect regardless of `samples`.
    const geometry = new THREE.PlaneGeometry(
      2 * FRUSTUM_HALF_EXTENT,
      2 * FRUSTUM_HALF_EXTENT,
    );
    const material = new THREE.MeshBasicMaterial({
      map: regionPixelTexture(region),
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.name = `map-region-${region.face}:${region.level}:${region.ix}:${region.iy}`;
    scene.add(mesh);

    // Symbol overlay: peaks/forests/waves on top of the textured quad. The
    // rung will be driven from the map camera's zoom in a later task; for
    // now it's fixed at 'near' (the finest rung).
    symbols = buildMapSymbols(region);
    symbols.update("near");
    scene.add(symbols.group);
  }

  /** `'voxel'`: the relief diorama — an extruded-block heightfield colored
   * by the SAME per-node source `mountPixel`'s texture uses
   * (`pixelColorFor`), so Style ⟂ Lens holds. No symbol overlay yet (a 3D
   * diorama prop set for peaks/forests/waves is a followup, not this
   * campaign — see `.superpowers/sdd/followups.md`). */
  function mountVoxel(region: RegionScene): void {
    const geometry = buildVoxelHeightfieldGeometry(
      region,
      (nodeIndex) => pixelColorFor([0, 0, 0], region, nodeIndex),
      {
        extent: MAP_VOXEL_EXTENT,
        heightScale: MAP_VOXEL_HEIGHT_SCALE,
        bandM: MAP_VOXEL_BAND_M,
      },
    );
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.name = `map-region-voxel-${region.face}:${region.level}:${region.ix}:${region.iy}`;
    scene.add(mesh);
  }

  function mountRegion(region: RegionScene): void {
    clearMesh();
    if (activeStyle === "voxel") mountVoxel(region);
    else mountPixel(region);
  }

  function setRegion(region: RegionScene | null): void {
    currentRegion = region;
    if (!region) {
      clearMesh();
      return;
    }
    mountRegion(region);
  }

  function setStyle(style: MapStyle): void {
    activeStyle = style;
    if (style === "voxel") applyIsoCamera();
    else applyPixelCamera();
    if (currentRegion) mountRegion(currentRegion);
    else clearMesh();
  }

  function render(renderer: THREE.WebGLRenderer): void {
    renderer.render(scene, camera);
  }

  function dispose(): void {
    clearMesh();
  }

  return { scene, camera, setRegion, setStyle, render, dispose };
}
