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
import type { EclipseEvent, Feature, SystemScene, TilesScene } from '../sim/scene';
import { rotationPhase, worldPhase } from '../sim/ephemeris';
import { REFERENCE_RADIUS_M, buildTileGeometry, sampleTile, stitchNormals, tileIndex } from './worldMesh';
import type { Lens } from './lens';
import { naturalLens } from './lens';
import { LOD_MIN_LEVEL, TILE_QUADS, globeLodLevel, tileGrid, tileKey, type TileId } from './cubeSphere';
import { createOcean } from './ocean';
import { createWinds } from './winds';
import { iceFraction } from './ice';
import { systemSeasonalContext } from '../sim/lockedClimate';
import { MARGIN as ECLIPSE_MARGIN, bandVisibleAt, buildEclipseBand } from './eclipseBand';

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

/** Ambient intensity of the night-side fill when enabled — bright enough to
 * read the unlit hemisphere, low enough that the daylit side (directional
 * 2.2 on top) still reads as the day side. */
const NIGHT_FILL_INTENSITY = 0.9;

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

/** The mesh's diurnal spin, day-driven — `subsolarPoint`'s frozen twin.
 * `hold=false` reproduces today's spin (`rotationPhase(sys, day) * TAU`);
 * `hold=true` (the seasonal hold, engaged at the fast rates Task 8 unlocked)
 * fixes it at a reference rotation (0) so the planet holds a face while the
 * light's latitude (from `subsolarPoint`, untouched by `hold`) keeps
 * advancing with the season — the sun visibly drifts N/S over a watched
 * year instead of blurring into a diurnal smear. A no-op on a tidally
 * locked world: `rotationPhase` already gives it no sweep to freeze. */
export function seasonalSpinZ(sys: SystemScene, day: number, hold: boolean): number {
  return hold ? 0 : rotationPhase(sys, day) * TAU;
}

/** Unit vector for a (lat, lon) in degrees — the inverse of `cubeSphere.ts`'s
 * `unitLatLon` (lat = asin(z), lon = atan2(y, x)). Exported so `./eclipseBand`
 * builds its shadow-band geometry from the same one true convention rather
 * than a second copy. */
export function latLonToUnit(latDeg: number, lonDeg: number): THREE.Vector3 {
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
  /** Show or hide the ocean's drifting wave pattern (the normal map). Off
   * leaves a smooth, still sea; the depth grading stays. */
  setWaves(on: boolean): void;
  /** Turn the ocean's sun-glint (specular highlight) on or off. Independent
   * of the waves toggle. */
  setGlint(on: boolean): void;
  /** Fill the night side with ambient light (on) so the unlit hemisphere is
   * readable, or leave the honest dark terminator (off, the default). */
  setNightFill(on: boolean): void;
  /** Toggle the seasonal hold (Task 9): freezes the mesh's diurnal spin
   * (`spinGroup.rotation.z`, via `seasonalSpinZ`) while the terminator light
   * keeps tracking the sub-solar latitude, so a year's seasons are watchable
   * at the fast clock rates without the daily spin blurring the picture.
   * `main.ts` engages it once the active clock mult crosses the old
   * (pre-Task-8) globe cap. Off by default, matching today's spin. */
  setSeasonalHold(on: boolean): void;
}

/** Build the globe view: a cube-sphere mesh displaced by real relief,
 * colored by ocean depth or biome, carrying settlement markers, and lit by a
 * fixed-direction "sun" whose latitude tracks the season while the mesh
 * itself spins by `rotationPhase` — together reproducing `subsolarPoint`'s
 * lat/lon on the rotating surface without moving the light twice. `eclipses`
 * (default `[]`, so existing callers still compile) are this world's dated
 * eclipse events; each solar one's shadow band (`./eclipseBand.ts`) is drawn
 * on the globe while `update`'s day is within `bandVisibleAt`'s margin. */
export function createGlobeView(
  tiles: TilesScene,
  sys: SystemScene,
  eclipses: EclipseEvent[] = [],
): GlobeView {
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
  // Built once from the (fixed, for this view's lifetime) system scene —
  // routes a locked tiles document's temperature through the librating-
  // substellar reconstruction (`../sim/lockedClimate`) instead of the
  // spinning-only `temperatureAt`.
  const seasonalCtx = systemSeasonalContext(sys);
  const colorAt = (i: number) => activeLens.colorAt(tiles, i, lastDay ?? 0, seasonalCtx);

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const tileGridN = TILE_QUADS + 1;

  // The globe's surface is a uniform set of cube-sphere tiles at `renderLevel`
  // (adaptive LOD): level 0 is a whole face, each deeper level a 2×2
  // subdivision, so a closer camera can rebuild at a higher level for smoother
  // relief. Everything downstream is keyed by tile SLOT, not face — the
  // per-vertex tile-index cache, the base colours, the repaint, the
  // true-relief rebuild — so `buildTiles()` at any level Just Works.
  let renderLevel = LOD_MIN_LEVEL;
  let reliefOn = false; // true-relief (1×) vs schematic (RELIEF_EXAGGERATION×)
  const reliefScale = (): number => (reliefOn ? 1 : RELIEF_EXAGGERATION);

  let tileMeshes: THREE.Mesh[] = [];
  let tileGeoms: THREE.BufferGeometry[] = [];
  // Per-vertex tile-index cache, one Int32Array per tile: a living lens
  // (temperature) or ice recolours per frame, so `repaint` reuses this rather
  // than re-deriving lat/lon → tile per vertex per tick.
  let tileIdxByTile: Int32Array[] = [];
  // The active lens's static colours per tile, rebuilt on `setLens`/`buildTiles`.
  // For a living lens this is the day-0 snapshot, overwritten per repaint; for
  // a static one it IS the final colour (modulo the ice blend).
  let baseColorByTile: Float32Array[] = [];

  /** The 6·4^level tiles of a uniform level, row-major per face. */
  function tilesAtLevel(level: number): TileId[] {
    const span = 1 << level;
    const out: TileId[] = [];
    for (let face = 0; face < 6; face++) {
      for (let iy = 0; iy < span; iy++) {
        for (let ix = 0; ix < span; ix++) out.push({ face, level, ix, iy });
      }
    }
    return out;
  }

  function rebuildBase(): void {
    baseColorByTile = tileIdxByTile.map((idx) => {
      const buf = new Float32Array(idx.length * 3);
      for (let v = 0; v < idx.length; v++) {
        const rgb = activeLens.colorAt(tiles, idx[v]!, lastDay ?? 0, seasonalCtx);
        buf[3 * v] = rgb[0] / 255;
        buf[3 * v + 1] = rgb[1] / 255;
        buf[3 * v + 2] = rgb[2] / 255;
      }
      return buf;
    });
  }

  /** (Re)build the whole tile set at `renderLevel` and the current relief
   * scale: swap the meshes into `spinGroup`, recompute the per-vertex
   * tile-index cache and base colours, stitch the cube-edge seams, and repaint
   * for the current day. Cheap enough to run on a level change (a few times
   * across a zoom), not per frame. */
  function buildTiles(): void {
    for (const m of tileMeshes) {
      spinGroup.remove(m);
      m.geometry.dispose();
    }
    tileMeshes = [];
    tileGeoms = [];
    tileIdxByTile = [];
    const scale = reliefScale();
    for (const t of tilesAtLevel(renderLevel)) {
      const geom = buildTileGeometry(tiles, t, GLOBE_RADIUS, scale, colorAt);
      const mesh = new THREE.Mesh(geom, material);
      mesh.name = `globe-tile-${tileKey(t)}`;
      spinGroup.add(mesh);
      tileMeshes.push(mesh);
      tileGeoms.push(geom);
      const grid = tileGrid(t);
      const idx = new Int32Array(tileGridN * tileGridN);
      for (let i = 0; i < idx.length; i++) idx[i] = tileIndex(tiles, grid.lats[i]!, grid.lons[i]!);
      tileIdxByTile.push(idx);
    }
    // Each tile computes its normals alone; reconcile them across shared edges
    // or the directional light draws every seam (worst at 60× relief).
    stitchNormals(tileGeoms);
    rebuildBase();
    repaint(lastDay ?? 0, true);
  }
  buildTiles();

  /** Repaints the current tile set for `day`: the active lens's colour per
   * vertex, blended toward `ICE_COLOR` only under `natural` (a data lens must
   * show its data, not decorative ice — the blend would corrupt its colormap).
   * Repaints only when the day actually moved, or when forced (a lens swap or
   * a fresh tile rebuild). A static, non-natural lens (no ice, no day
   * dependency) repaints once and never again. */
  function repaint(day: number, force = false): void {
    const still = !activeLens.dependsOnDay && activeLens.id !== naturalLens.id;
    if (!force && day === lastDay) return;
    if (!force && still && lastDay !== null) return;
    lastDay = day;
    const icy = activeLens.id === naturalLens.id;
    for (let ti = 0; ti < tileGeoms.length; ti++) {
      const color = tileGeoms[ti]!.getAttribute('color') as THREE.BufferAttribute;
      const idx = tileIdxByTile[ti]!;
      const base = baseColorByTile[ti]!;
      for (let v = 0; v < idx.length; v++) {
        let r: number, g: number, b: number;
        if (activeLens.dependsOnDay) {
          const rgb = activeLens.colorAt(tiles, idx[v]!, day, seasonalCtx);
          r = rgb[0] / 255;
          g = rgb[1] / 255;
          b = rgb[2] / 255;
        } else {
          r = base[3 * v]!;
          g = base[3 * v + 1]!;
          b = base[3 * v + 2]!;
        }
        if (icy) {
          const frac = iceFraction(tiles, idx[v]!, day, seasonalCtx);
          r += (ICE_COLOR[0] - r) * frac;
          g += (ICE_COLOR[1] - g) * frac;
          b += (ICE_COLOR[2] - b) * frac;
        }
        color.setXYZ(v, r, g, b);
      }
      color.needsUpdate = true;
    }
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
  function setWaves(on: boolean): void {
    ocean.setWaves(on);
  }
  function setGlint(on: boolean): void {
    ocean.setGlint(on);
  }
  /** Toggle true-relief (1×, honest) vs the exaggerated schematic. With the
   * tile set rebuildable, this just rebuilds it at the new relief scale (a
   * user action, rare — no need to keep a second geometry set warm) and
   * reseats the markers on the moved terrain. */
  function setTrueRelief(on: boolean): void {
    if (on === reliefOn) return;
    reliefOn = on;
    buildTiles();
    // The terrain the markers stand on just moved — reseat them on it.
    for (const marker of markers) placeMarker(marker, reliefScale());
    ocean.setTrueRelief(on);
  }

  /** Adaptive LOD: pick the level for the camera's distance to the globe
   * centre and rebuild the tile set if it changed (monotonic in closeness, so
   * this fires only a few times across a zoom, not per frame). */
  function setLodForDistance(distance: number): void {
    const level = globeLodLevel(distance, GLOBE_RADIUS);
    if (level !== renderLevel) {
      renderLevel = level;
      buildTiles();
    }
  }

  const markers = clusterFeatures(tiles.features).map((site) => buildSiteMarker(tiles, site));
  for (const marker of markers) {
    placeMarker(marker, RELIEF_EXAGGERATION);
    spinGroup.add(marker.group);
  }

  // Eclipse shadow bands (Task 8): glued to geographic surface coords like
  // the markers above, so this group mounts on `spinGroup`, not `root` — a
  // band on `root` would sit still while the planet turns beneath it. Built
  // lazily per solar event and cached, mirroring `setTrueRelief`'s lazy
  // true-geometry build above; lunar events (`track === null`) are skipped.
  const eclipseGroup = new THREE.Object3D();
  eclipseGroup.name = 'globe-eclipse-bands';
  spinGroup.add(eclipseGroup);
  const bandMeshes: (THREE.Mesh | null)[] = eclipses.map(() => null);

  // The honest day/night terminator (spec §4½): a single directional sun,
  // no ambient, so the night side falls to shader darkness by default.
  const light = new THREE.DirectionalLight(0xfff4e0, 2.2);
  light.target.position.set(0, 0, 0);
  root.add(light);
  root.add(light.target);
  // An optional night-side fill: off (intensity 0) by default, so the honest
  // terminator is unchanged. Turned up, it lifts the unlit hemisphere out of
  // black so the far side's terrain and lens colors (temperature especially)
  // stay readable through the night — the daylit side keeps the directional
  // gradient on top, so which side faces the sun still reads.
  const nightFill = new THREE.AmbientLight(0xffffff, 0);
  root.add(nightFill);
  function setNightFill(on: boolean): void {
    nightFill.intensity = on ? NIGHT_FILL_INTENSITY : 0;
  }

  let selectedGroup: string | null = null;
  function setSelected(featureName: string | null): void {
    selectedGroup = featureName === null ? null : `feature-${featureName}`;
  }

  // Task 9's seasonal hold: freezes spinGroup's diurnal spin at the fast
  // clock rates so a year is watchable with the planet holding a face — see
  // `seasonalSpinZ`'s doc comment. Off by default, matching today's spin.
  let seasonalHold = false;
  function setSeasonalHold(on: boolean): void {
    seasonalHold = on;
  }

  const upWorld = new THREE.Vector3(); // update()'s scratch — no per-frame allocation
  const zAxis = new THREE.Vector3(0, 0, 1);
  function update(day: number, camera?: THREE.Camera): void {
    const sub = subsolarPoint(sys, day);
    // Fixed reference azimuth 0: the daily sweep comes from spinning
    // spinGroup below, not from moving the light's longitude — see the
    // function doc's derivation. The light is unaffected by the seasonal
    // hold: its latitude term keeps advancing regardless, which is the
    // whole point of freezing the mesh instead of the light.
    light.position.copy(latLonToUnit(sub.lat, 0)).multiplyScalar(LIGHT_DISTANCE);
    spinGroup.rotation.z = seasonalSpinZ(sys, day, seasonalHold);
    ocean.update(day);
    // The active lens (and ice, under natural) is blended into the base
    // vertex color before the material's lighting, so it inherits the
    // honest terminator for free — no ambient light means the recolored
    // night side still shades to dark.
    repaint(day);
    // Show whichever solar events' bands are due, hide the rest; build a
    // band's geometry only the first time it becomes visible.
    for (let i = 0; i < eclipses.length; i++) {
      const event = eclipses[i]!;
      if (event.track === null) continue;
      const visible = bandVisibleAt(event, day, ECLIPSE_MARGIN);
      if (visible && bandMeshes[i] === null) {
        const mesh = buildEclipseBand(event.track, GLOBE_RADIUS);
        eclipseGroup.add(mesh);
        bandMeshes[i] = mesh;
      }
      const mesh = bandMeshes[i];
      if (mesh) mesh.visible = visible;
    }
    if (!camera) return;
    // Adaptive LOD: the globe centre is the origin of this view, so the
    // camera's distance from it drives the tile level. Rebuilds only on a
    // level change.
    setLodForDistance(camera.position.length());
    for (const m of markers) {
      upWorld.copy(m.up).applyAxisAngle(zAxis, spinGroup.rotation.z);
      const near = onNearSide(upWorld, camera.position, GLOBE_RADIUS);
      m.dot.visible = near;
      m.label.visible = near && m.group.name === selectedGroup;
    }
  }

  update(0);

  return {
    object3d: root,
    update,
    setTrueRelief,
    setSelected,
    setLens,
    setWinds,
    setWaves,
    setGlint,
    setNightFill,
    setSeasonalHold,
  };
}

/** The tile index vertex `v` of face `face`'s level-0 geometry maps to — the
 * same per-vertex lookup `createGlobeView` precomputes into `tileIdxByFace`,
 * exposed so a test can predict a specific vertex's color without
 * duplicating the grid math. */
export function tileIndexOfVertex(tiles: TilesScene, face: number, v: number): number {
  const grid = tileGrid({ face, level: 0, ix: 0, iy: 0 });
  return tileIndex(tiles, grid.lats[v]!, grid.lons[v]!);
}
