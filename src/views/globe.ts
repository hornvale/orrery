/** The globe view: the planet itself — a cube-sphere mesh (reusing gg's
 * `cubeSphere.ts` addressing, not reinventing it) displaced by real relief
 * from `scene/tiles/v1`, colored by ocean depth or biome, carrying
 * settlement markers, and lit by an honest day/night terminator.
 *
 * Two kinds of surface, same split as `./system.ts`: pure sampling/position
 * math (`sampleTile`, `subsolarPoint` — no WebGL, unit-tested directly) and
 * the three.js scene graph builder (`createGlobeView`) that consumes it.
 */
import * as THREE from 'three';
import type { Feature, SystemScene, TilesScene } from '../sim/scene';
import { rotationPhase, worldPhase } from '../sim/ephemeris';
import { REFERENCE_RADIUS_M, buildFaceGeometry, sampleTile, stitchNormals, tileIndex } from './worldMesh';
import type { Lens } from './lens';
import { naturalLens } from './lens';
import { TILE_QUADS, tileGrid } from './cubeSphere';
import { createOcean } from './ocean';
import { createWinds } from './winds';
import { iceFraction } from './ice';

const TAU = Math.PI * 2;

/** Schematic globe radius (world units) — this view stands alone (not
 * sharing `./system.ts`'s AU scale), so the number is arbitrary. */
export const GLOBE_RADIUS = 2;

/** How much the relief displacement is exaggerated over true scale, so a
 * planet's mountains and trenches are visible on a rendered sphere at all.
 * The HUD caption must show this number — spec §4½: the render admits its
 * lie. */
export const RELIEF_EXAGGERATION = 60;

/** How far above the *displaced* terrain a marker dot sits, as a fraction
 * of `GLOBE_RADIUS` — just enough that the dot never z-fights its own
 * ground, close enough that it reads as standing on it. */
export const MARKER_CLEARANCE = 0.006;

/** Distance of the directional "sun" light from the globe center, in world
 * units — far enough to read as parallel light across the whole sphere. */
const LIGHT_DISTANCE = GLOBE_RADIUS * 20;

/** Ice-white blend target (0-1 RGB, matching the geometry `color` attribute's
 * scale) — the near-white a frozen tile's biome/ocean color blends toward as
 * `iceFraction` rises. Blended into the *base* vertex color before the
 * directional light shades it, so night-side ice still goes dark (spec
 * §4½'s honest terminator applies to ice the same as everything else). */
const ICE_COLOR: readonly [number, number, number] = [0.92, 0.95, 0.98];

// sampleTile now lives in `./worldMesh` (the shared face-mesh builder); it
// is re-exported below for existing consumers/tests.
export { sampleTile } from './worldMesh';

/** The point on the globe directly facing the star at `day`. Latitude comes
 * from the golden-pinned `worldPhase` (never reimplemented) swinging
 * ±obliquity over the year. Longitude comes from `rotationPhase` for a
 * spinning world — 0 for a tidally locked one, which has no rotation to
 * derive a sweep from. */
export function subsolarPoint(sys: SystemScene, day: number): { lat: number; lon: number } {
  const lat = sys.world.obliquityDeg * Math.sin(TAU * worldPhase(sys, day));
  if (sys.world.dayLengthDays === null) {
    return { lat, lon: 0 };
  }
  // rotationPhase sweeps [0,1) once per day_length_days; the sub-solar
  // longitude on the rotating surface sweeps the opposite way (the ground
  // spins to meet the sun, not the reverse). Wrapped into (-180, 180].
  const swept = -rotationPhase(sys, day) * 360;
  const lon = ((((swept + 180) % 360) + 360) % 360) - 180;
  return { lat, lon };
}

/** Unit vector for a (lat, lon) in degrees — the inverse of `cubeSphere.ts`'s
 * `unitLatLon` (lat = asin(z), lon = atan2(y, x)). */
function latLonToUnit(latDeg: number, lonDeg: number): THREE.Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
}

/** World units per label-canvas pixel — the original single-line sprite was
 * a 256×64 canvas at scale (0.5, 0.125), i.e. 1/512 per px; kept so label
 * text renders at the same apparent size it always did. */
const LABEL_WORLD_PER_PX = 0.5 / 256;

/** A canvas-texture sprite carrying one line per entry of `lines` — a
 * marker site names everything that stands there, stacked, instead of
 * several sprites overprinting each other at the same coordinates.
 * Real browsers always give a 2D context here (this app already requires
 * WebGL for the rest of the scene); a `null` context only shows up in a
 * headless DOM stub (happy-dom has no canvas 2D renderer) — fall back to an
 * untextured sprite rather than crash createGlobeView in that case. */
function buildLabelSprite(lines: string[]): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0 }));
  }
  const font = '28px ui-monospace, monospace';
  const pad = 8;
  const lineHeight = 36;
  ctx.font = font;
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  canvas.width = Math.ceil(textWidth) + 2 * pad;
  canvas.height = lineHeight * lines.length + 2 * pad;
  ctx.font = font; // resizing the canvas resets 2D state
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f5e9c8';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => ctx.fillText(line, pad, pad + lineHeight * (i + 0.5)));
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(canvas.width * LABEL_WORLD_PER_PX, canvas.height * LABEL_WORLD_PER_PX, 1);
  return sprite;
}

/** One marker site: every feature standing on the same exact (lat, lon).
 * Real documents put several settlements (and sometimes the flagship) on
 * identical coordinates, so the site — not the feature — is the drawable
 * unit; one dot, one stacked label. */
export interface FeatureSite {
  latitude: number;
  longitude: number;
  /** Names at this site, the flagship's first when present. */
  names: string[];
  hasFlagship: boolean;
}

/** Group features into sites by exact coordinates, keeping first-seen site
 * order; within a site the flagship's name is hoisted to the front (it
 * names the marker group, so a click inspects the flagship). */
export function clusterFeatures(features: Feature[]): FeatureSite[] {
  const byCoord = new Map<string, FeatureSite>();
  for (const f of features) {
    const key = `${f.latitude},${f.longitude}`;
    const site = byCoord.get(key);
    if (!site) {
      byCoord.set(key, {
        latitude: f.latitude,
        longitude: f.longitude,
        names: [f.name],
        hasFlagship: f.kind === 'flagship',
      });
    } else if (f.kind === 'flagship') {
      site.names.unshift(f.name);
      site.hasFlagship = true;
    } else {
      site.names.push(f.name);
    }
  }
  return [...byCoord.values()];
}

/** One built marker: its scene nodes plus what placement needs — the site's
 * surface direction and sampled elevation (placement re-runs on every
 * relief toggle, so it can't be baked into construction). */
interface Marker {
  group: THREE.Object3D;
  dot: THREE.Mesh;
  label: THREE.Sprite;
  up: THREE.Vector3;
  elevationM: number;
}

/** Build one site's marker: a dot (flagship gold if the flagship stands
 * here) plus the stacked name label. Positions are set by `placeMarker`. */
function buildSiteMarker(tiles: TilesScene, site: FeatureSite): Marker {
  const group = new THREE.Object3D();
  group.name = `feature-${site.names[0]}`;
  const up = latLonToUnit(site.latitude, site.longitude);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS * 0.015, 8, 6),
    new THREE.MeshBasicMaterial({ color: site.hasFlagship ? 0xffd76e : 0xe8e8f0 }),
  );
  const label = buildLabelSprite(site.names);
  label.visible = false; // labels are quiet by default; selection shows them
  group.add(dot);
  group.add(label);
  return { group, dot, label, up, elevationM: sampleTile(tiles, site.latitude, site.longitude, 'elevation_m') };
}

/** Slack on the limb test, in units of cos θ — markers sit slightly above
 * the surface, so a marker exactly on the geometric horizon is still
 * (barely) visible; hide it a touch past instead of exactly at. */
const DOT_HORIZON_SLACK = 0.02;

/** Whether a surface point at world-frame direction `upWorld` is on the
 * camera's side of the globe: a point at angle θ from the camera direction
 * passes the limb when cos θ < r/d. */
export function onNearSide(upWorld: THREE.Vector3, cameraPos: THREE.Vector3, radius: number): boolean {
  const d = cameraPos.length();
  if (d <= radius) return false;
  return upWorld.dot(cameraPos) / d > radius / d - DOT_HORIZON_SLACK;
}

/** Seat a marker on the terrain as the mesh renders it: the dot at the
 * face-geometry displacement formula plus `MARKER_CLEARANCE`, the label
 * floating just above the dot by its own half-height. */
function placeMarker(m: Marker, reliefScale: number): void {
  const surface = GLOBE_RADIUS * (1 + (reliefScale * m.elevationM) / REFERENCE_RADIUS_M);
  const dotRadius = surface + GLOBE_RADIUS * MARKER_CLEARANCE;
  m.dot.position.copy(m.up).multiplyScalar(dotRadius);
  m.label.position.copy(m.up).multiplyScalar(dotRadius + m.label.scale.y / 2 + GLOBE_RADIUS * 0.02);
}

/** The globe view's public surface: a mountable object graph plus the
 * per-frame driver a caller (main.ts's rAF loop) needs. */
export interface GlobeView {
  /** The whole globe's root node — mount this once into a THREE.Scene. */
  object3d: THREE.Object3D;
  /** Repositions the terminator light and spins the mesh for `day`; call
   * every frame. Given the rendering `camera`, also culls markers past the
   * limb and shows the selected site's label — omitting it (a caller that
   * predates marker gating) leaves every marker shown. */
  update(day: number, camera?: THREE.Camera): void;
  /** Toggle exaggerated relief (the default, `RELIEF_EXAGGERATION`×) vs true
   * (1×) relief — swaps in lazily built true-scale face geometry. */
  setTrueRelief(on: boolean): void;
  /** Select the site whose marker group is named for `featureName` — its
   * stacked name label shows (while on the near side) until deselected with
   * `null`. Labels are quiet by default; a click asks for a name. */
  setSelected(featureName: string | null): void;
  /** Swap the active lens: rebuilds the static base colors from `lens` and
   * repaints both geometry sets immediately (not just on the next frame) so
   * a lens change is never left showing the old colors. Ice keeps blending
   * under `natural` only — see `repaintInto`'s doc comment. */
  setLens(lens: Lens): void;
  /** Show or hide the prevailing-wind overlay — a no-op on a tidally locked
   * world, where `createWinds` built nothing to show. */
  setWinds(on: boolean): void;
}

/** Build the globe view: a cube-sphere mesh displaced by real relief,
 * colored by ocean depth or biome, carrying settlement markers, and lit by a
 * fixed-direction "sun" whose latitude tracks the season while the mesh
 * itself spins by `rotationPhase` — together reproducing `subsolarPoint`'s
 * lat/lon on the rotating surface without moving the light twice. */
export function createGlobeView(tiles: TilesScene, sys: SystemScene): GlobeView {
  const root = new THREE.Object3D();
  root.name = 'globe-root';

  const spinGroup = new THREE.Object3D();
  spinGroup.name = 'globe-spin';
  root.add(spinGroup);

  // The active lens and the last day painted — declared before `colorAt`
  // (below) closes over them, since a face built later (true relief) must
  // start on whichever lens is active then, not hardcoded to `natural`.
  let activeLens: Lens = naturalLens;
  let lastDay: number | null = null;
  const colorAt = (i: number) => activeLens.colorAt(tiles, i, lastDay ?? 0);

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const faceMeshes: THREE.Mesh[] = [];
  for (let face = 0; face < 6; face++) {
    const mesh = new THREE.Mesh(
      buildFaceGeometry(tiles, face, GLOBE_RADIUS, RELIEF_EXAGGERATION, colorAt),
      material,
    );
    mesh.name = `globe-face-${face}`;
    spinGroup.add(mesh);
    faceMeshes.push(mesh);
  }
  const schematicGeoms = faceMeshes.map((m) => m.geometry);
  // Each face computes its normals alone; reconcile them across cube edges
  // or directional light draws every edge as a seam (worst at 60× relief).
  stitchNormals(schematicGeoms);

  // Per-vertex tile index precompute: `buildFaceGeometry` bakes each vertex's
  // color once at build time, but a living lens (temperature) or ice must
  // advance with the sim clock, so `update(day)` may recolor every frame the
  // day changes. Rather than re-derive lat/lon → tile per vertex per tick,
  // precompute each face's per-vertex tile index once (same grid
  // `buildFaceGeometry` used — identical across schematic and true-relief
  // geometry, since only positions differ under relief) and reuse it both
  // for the active lens's repaint and for `iceFraction`.
  const tileGridN = TILE_QUADS + 1;
  const tileIdxByFace: Int32Array[] = [];
  for (let face = 0; face < 6; face++) {
    const grid = tileGrid({ face, level: 0, ix: 0, iy: 0 });
    const idx = new Int32Array(tileGridN * tileGridN);
    for (let i = 0; i < idx.length; i++) idx[i] = tileIndex(tiles, grid.lats[i]!, grid.lons[i]!);
    tileIdxByFace.push(idx);
  }

  // The active lens's static colors per face, rebuilt on `setLens`. For a
  // living lens this is the day-0 snapshot and is overwritten per repaint;
  // for a static one it IS the final color (modulo the ice blend below).
  const baseColorByFace: Float32Array[] = [];
  function rebuildBase(): void {
    baseColorByFace.length = 0;
    for (let face = 0; face < 6; face++) {
      const idx = tileIdxByFace[face]!;
      const buf = new Float32Array(idx.length * 3);
      for (let v = 0; v < idx.length; v++) {
        const rgb = activeLens.colorAt(tiles, idx[v]!, lastDay ?? 0);
        buf[3 * v] = rgb[0] / 255;
        buf[3 * v + 1] = rgb[1] / 255;
        buf[3 * v + 2] = rgb[2] / 255;
      }
      baseColorByFace.push(buf);
    }
  }
  rebuildBase();

  /** Paints `geoms` for `day`: the active lens's color per vertex, blended
   * toward `ICE_COLOR` only under `natural` (a data lens must show its data,
   * not decorative ice — the blend would corrupt its colormap). */
  function repaintInto(geoms: THREE.BufferGeometry[], day: number): void {
    const icy = activeLens.id === naturalLens.id;
    for (let face = 0; face < 6; face++) {
      const color = geoms[face]!.getAttribute('color') as THREE.BufferAttribute;
      const idx = tileIdxByFace[face]!;
      const base = baseColorByFace[face]!;
      for (let v = 0; v < idx.length; v++) {
        let r: number, g: number, b: number;
        if (activeLens.dependsOnDay) {
          const rgb = activeLens.colorAt(tiles, idx[v]!, day);
          r = rgb[0] / 255;
          g = rgb[1] / 255;
          b = rgb[2] / 255;
        } else {
          r = base[3 * v]!;
          g = base[3 * v + 1]!;
          b = base[3 * v + 2]!;
        }
        if (icy) {
          const frac = iceFraction(tiles, idx[v]!, day);
          r += (ICE_COLOR[0] - r) * frac;
          g += (ICE_COLOR[1] - g) * frac;
          b += (ICE_COLOR[2] - b) * frac;
        }
        color.setXYZ(v, r, g, b);
      }
      color.needsUpdate = true;
    }
  }

  /** Repaints only when the day actually moved, or when forced (a lens swap
   * or freshly built true-relief geometry). A static, non-natural lens (no
   * ice, no day dependency) repaints once and never again. */
  function repaint(day: number, force = false): void {
    const still = !activeLens.dependsOnDay && activeLens.id !== naturalLens.id;
    if (!force && day === lastDay) return;
    if (!force && still && lastDay !== null) return;
    lastDay = day;
    repaintInto(schematicGeoms, day);
    if (trueGeoms) repaintInto(trueGeoms, day);
  }

  function setLens(lens: Lens): void {
    activeLens = lens;
    rebuildBase();
    repaint(lastDay ?? 0, true);
    // Water is a `natural`-only decoration, same argument as the ice blend
    // above: ocean tiles carry real data (sea temperature, moisture, the
    // plate beneath them, boundary unrest), and seed 42 is ~73% sea — a data
    // lens left veiled under translucent blue would be hiding most of its
    // own field. `topographic` is included in the hiding: water conceals the
    // bathymetry that lens exists to show.
    ocean.object3d.visible = lens.id === naturalLens.id;
  }

  // The water layer: a smooth translucent sphere at sea level, over the
  // displaced seafloor — spinning with the ground so wave motion (stage 2)
  // stays fixed to the world, not the camera.
  const ocean = createOcean(tiles, GLOBE_RADIUS, RELIEF_EXAGGERATION);
  spinGroup.add(ocean.object3d);
  // The globe starts on `naturalLens` (see `activeLens` above), so water
  // starts visible from the very first frame — explicit rather than relying
  // on three.js's `Object3D.visible` default.
  ocean.object3d.visible = activeLens.id === naturalLens.id;

  // The prevailing-wind overlay: build-once static geometry (windAt takes no
  // day — see winds.ts's doc comment), riding the world's spin like the
  // ocean above. `null` on a tidally locked world (no circulation bands) —
  // there is simply nothing to mount or toggle.
  const winds = createWinds(tiles, GLOBE_RADIUS);
  if (winds) spinGroup.add(winds.object3d);
  function setWinds(on: boolean): void {
    winds?.setVisible(on);
  }
  // True-relief geometry (1x, honest) is expensive to build and most
  // sessions never ask for it — construct lazily on first toggle, not here.
  let trueGeoms: THREE.BufferGeometry[] | null = null;
  function setTrueRelief(on: boolean): void {
    if (on && trueGeoms === null) {
      trueGeoms = Array.from({ length: 6 }, (_, f) => buildFaceGeometry(tiles, f, GLOBE_RADIUS, 1, colorAt));
      stitchNormals(trueGeoms);
      // Freshly built geometry starts on the active lens's day-0/static
      // colors baked by `colorAt`, but never the ice blend (baked at build
      // time via `colorAt`, which never blends ice) — force-paint it now
      // for the day already in effect rather than waiting on the next
      // update() to notice the day is "unchanged".
      repaint(lastDay ?? 0, true);
    }
    faceMeshes.forEach((m, f) => { m.geometry = (on ? trueGeoms! : schematicGeoms)[f]!; });
    // The terrain the markers stand on just moved — reseat them on it.
    for (const marker of markers) placeMarker(marker, on ? 1 : RELIEF_EXAGGERATION);
    ocean.setTrueRelief(on);
  }

  const markers = clusterFeatures(tiles.features).map((site) => buildSiteMarker(tiles, site));
  for (const marker of markers) {
    placeMarker(marker, RELIEF_EXAGGERATION);
    spinGroup.add(marker.group);
  }

  // No ambient light here: the night side is meant to fall to shader
  // darkness (spec §4½) — the system view's ambient wash belongs to that
  // view's always-lit spheres, not this one's honest terminator.
  const light = new THREE.DirectionalLight(0xfff4e0, 2.2);
  light.target.position.set(0, 0, 0);
  root.add(light);
  root.add(light.target);

  let selectedGroup: string | null = null;
  function setSelected(featureName: string | null): void {
    selectedGroup = featureName === null ? null : `feature-${featureName}`;
  }

  const upWorld = new THREE.Vector3(); // update()'s scratch — no per-frame allocation
  const zAxis = new THREE.Vector3(0, 0, 1);
  function update(day: number, camera?: THREE.Camera): void {
    const sub = subsolarPoint(sys, day);
    // Fixed reference azimuth 0: the daily sweep comes from spinning
    // spinGroup below, not from moving the light's longitude — see the
    // function doc's derivation.
    light.position.copy(latLonToUnit(sub.lat, 0)).multiplyScalar(LIGHT_DISTANCE);
    spinGroup.rotation.z = rotationPhase(sys, day) * TAU;
    ocean.update(day);
    // The active lens (and ice, under natural) is blended into the base
    // vertex color before the material's lighting, so it inherits the
    // honest terminator for free — no ambient light means the recolored
    // night side still shades to dark.
    repaint(day);
    if (!camera) return;
    for (const m of markers) {
      upWorld.copy(m.up).applyAxisAngle(zAxis, spinGroup.rotation.z);
      const near = onNearSide(upWorld, camera.position, GLOBE_RADIUS);
      m.dot.visible = near;
      m.label.visible = near && m.group.name === selectedGroup;
    }
  }

  update(0);

  return { object3d: root, update, setTrueRelief, setSelected, setLens, setWinds };
}

/** The tile index vertex `v` of face `face`'s level-0 geometry maps to — the
 * same per-vertex lookup `createGlobeView` precomputes into `tileIdxByFace`,
 * exposed so a test can predict a specific vertex's color without
 * duplicating the grid math. */
export function tileIndexOfVertex(tiles: TilesScene, face: number, v: number): number {
  const grid = tileGrid({ face, level: 0, ix: 0, iy: 0 });
  return tileIndex(tiles, grid.lats[v]!, grid.lons[v]!);
}
