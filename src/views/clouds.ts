/** The cloud layer (The Mantle): a transparent equirectangular texture shell
 * riding just above the globe's relief, replacing the earlier particle
 * overlay (`stepParticle`/`CLOUD_PARTICLES`, wind-advected puffs) with a
 * single static `THREE.DataTexture` built once from Task 2's
 * `cloudTextureData` (`./cloudTexture.ts`) and drifted slowly in longitude
 * for eyecandy motion — no per-day texture regeneration, no particle
 * bookkeeping. Sibling to `./ocean.ts`/`./winds.ts` in spirit (a
 * build-once three.js wrapper over pure sim data, mirroring
 * `./moonTexture.ts`'s pixel-math/DataTexture split), but the geometry
 * itself is trivial (a sphere) — the interesting work lives in
 * `./cloudTexture.ts`'s pixel math and in getting this shell's UVs to line
 * up with the globe's own lon/lat convention.
 *
 * ORIENTATION: `THREE.SphereGeometry` is built Y-up (its polar axis is
 * local +Y; at the equator, texture u=0 sits at local -X), but this app's
 * tile data is Z-up (`./globe.ts`'s `latLonToUnit`: `z = sin(lat)`, and
 * `spinGroup` spins around Z) — the same mismatch `./system.ts` corrects
 * for its own (Y-up) orbital diagram (see its `worldAxis.rotation.x`
 * comment, which rotates the opposite direction: Z-up data into a Y-up
 * scene). Rotating this shell +90° about local X maps the sphere's local
 * +Y pole onto world +Z (north stays north); working that rotation through
 * the sphere's own vertex formula shows texture u=0 (its default seam)
 * then lands at world longitude 180°, and u increases with longitude at
 * the same rate `./worldMesh.ts`'s columns do (col 0 = lon −180) — so
 * u=0..1 already matches the texture data's column convention with no
 * extra y-rotation needed. `SHELL_ROTATION_Y` is kept as a named escape
 * hatch for a later visual pass rather than an unexplained magic 0.
 *
 * `texture.flipY = true` makes the DataTexture's row 0 (lat +90, the north
 * pole per `./worldMesh.ts`'s `tileIndex` convention) land at the sphere's
 * v=0 (its own north pole, uv.y=1) — `DataTexture` defaults `flipY` to
 * `false` (unlike a loaded image texture), which would otherwise put the
 * *south* pole's row at the top. */
import * as THREE from 'three';
import type { TilesScene } from '../sim/scene';
import { cloudTextureData, CLOUD_TEX_H, CLOUD_TEX_W } from './cloudTexture';

/** Fractional headroom over the globe's undisplaced radius the shell sits
 * at: `radius * (1 + SHELL_HEADROOM)`. Sized to clear the tallest
 * schematic relief `./worldMesh.ts`'s displacement formula
 * (`radius * (1 + reliefScale * elevation_m / REFERENCE_RADIUS_M)`) can
 * plausibly produce: at the globe's default 60× exaggeration
 * (`RELIEF_EXAGGERATION`, `./globe.ts`), even a generous Everest-plus peak
 * (9,000 m) only displaces the surface by 60 × 9000 / 6.371e6 ≈ 8.5% —
 * 15% clears that with slack for taller exotic-world peaks. A tuning knob,
 * not a physical contract; not imported from `./globe.ts` to avoid a
 * module-init-order hazard in the (already-precedented, see
 * `./eclipseBand.ts`) circular import that would create. */
export const SHELL_HEADROOM = 0.15;

/** Radians of texture-longitude drift per sim day (`texture.offset.x`) —
 * gentle eyecandy motion, not a physical wind speed. A tuning knob the
 * controller may nudge by eye. */
export const DRIFT_RATE = 0.004;

/** The shell mesh's extra longitude rotation, radians, on top of the fixed
 * +90°-about-X pole alignment (see the file doc comment's derivation for
 * why 0 already lines up with `./worldMesh.ts`'s column convention). A
 * named escape hatch for a later visual pass rather than an unexplained
 * magic 0 on `mesh.rotation.y`. */
export const SHELL_ROTATION_Y = 0;

/** The cloud layer, or `null` when there is nothing to draw — mirrors
 * `./currents.ts`/`./winds.ts`'s `null`-on-no-data contract, so
 * `./globe.ts`'s `if (clouds) spinGroup.add(...)` and `main.ts`'s
 * `setCloudsAvailable` wiring need no changes. `cloudType`/
 * `weatherPropensity` (Task 1) are always-present fields, spinning or
 * locked, so the only genuine "nothing to show" case left is every tile
 * reading `cloudType` 0 (None) — an all-clear-sky document, which would
 * otherwise mount a fully-transparent shell for no reason. */
export function createClouds(
  tiles: TilesScene,
  radius: number,
): { object3d: THREE.Object3D; setVisible(on: boolean): void; update(day: number): void } | null {
  if (tiles.cloudType.every((t) => t === 0)) return null;

  const data = cloudTextureData(tiles);
  const texture = new THREE.DataTexture(data, CLOUD_TEX_W, CLOUD_TEX_H, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.flipY = true; // row 0 (north) -> the sphere's north pole; see file doc comment
  texture.wrapS = THREE.RepeatWrapping; // longitude drift wraps around the seam
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const shellRadius = radius * (1 + SHELL_HEADROOM);
  const geometry = new THREE.SphereGeometry(shellRadius, 96, 48);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide, // the far side is hidden by the shell + globe underneath it
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe-clouds';
  mesh.rotation.x = Math.PI / 2; // Y-up sphere pole -> this app's Z-up polar axis; see file doc comment
  mesh.rotation.y = SHELL_ROTATION_Y;
  mesh.visible = false;

  /** Advances the texture's longitude drift for `day` — a stateless
   * function of `day` alone (unlike the old particle overlay's
   * frame-to-frame integration), so a day *scrub* jumps cleanly instead of
   * needing a baseline call first. Never re-derives the texture itself. */
  function update(day: number): void {
    texture.offset.x = (((day * DRIFT_RATE) % 1) + 1) % 1; // always non-negative
  }

  return {
    object3d: mesh,
    setVisible: (on) => {
      mesh.visible = on;
    },
    update,
  };
}
