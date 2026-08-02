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
import type { EclipseEvent, Feature, RegionScene, SystemScene, TilesScene } from '../sim/scene';
import { rotationPhase, worldPhase } from '../sim/ephemeris';
import {
  REFERENCE_RADIUS_M,
  buildRegionTileGeometry,
  buildTileGeometry,
  buildVoxelRegionTileGeometryIndexed,
  buildVoxelTileGeometryIndexed,
  sampleTile,
  stitchNormals,
  tileIndex,
} from './worldMesh';
import type { Lens } from './lens';
import { naturalLens } from './lens';
import {
  LOD_CDLOD_MAX_LEVEL,
  LOD_MERGE_FACTOR,
  LOD_MIN_LEVEL,
  LOD_SPLIT_FACTOR,
  TILE_QUADS,
  children as childTiles,
  parent as parentTile,
  selectTiles,
  splitAncestorKeys,
  tileGrid,
  tileKey,
  unitLatLon,
  type TileId,
  type V3,
} from './cubeSphere';
import { createCascade, sortCameraFacingFirst } from './cascade';
import { regionPatchUnits } from './regionPatch';
import { createOcean } from './ocean';
import { createWinds } from './winds';
import { createCurrents } from './currents';
import { createClouds } from './clouds';
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

/** The Terraced style's elevation band width, in metres — every tile's
 * sampled elevation snaps to a multiple of this (`quantizeBands` in
 * `./worldMesh.ts`) before it displaces the surface, producing the stepped
 * "rice-terrace" contour. A tunable constant, not derived from the data;
 * start ~250m per the campaign brief, retune in the visual pass. */
const TERRACE_BAND_M = 250;

/** The Voxel style's block granularity — cells per tile edge, passed to
 * `buildVoxelTileGeometryIndexed`/`buildVoxelRegionTileGeometryIndexed`.
 * Deliberately bounded, NOT the full `TILE_QUADS` (64) lattice: a voxel
 * cell emits 6 (top) + up to 24 (walls) unshared vertices, so this directly
 * multiplies a mounted tile's vertex cost — start ~48 (chunky, and close to
 * the smooth path's own 65×65-shared-vertex budget); the perf/LOD ceiling
 * is Task 6's concern, not this wiring task's. */
const VOXEL_CELLS_PER_EDGE = 48;

/** The Voxel style's elevation band width, in metres — reuses
 * `quantizeBands` exactly like `TERRACE_BAND_M` (Task 2) does. A distinct
 * constant (not literally `TERRACE_BAND_M`) since a voxel "block" and a
 * terrace "contour" may want to read at different step heights once the
 * visual pass (Task 5) compares them side by side; same starting value for
 * now. */
const VOXEL_BAND_M = TERRACE_BAND_M;

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

/** The globe's render style — geometry + shading, orthogonal to the data
 * `Lens` (which only recolors). `smooth` is today's cube-sphere mesh;
 * `faceted` flat-shades the existing mesh, the cheapest style — just a
 * material flag; `terraced` (Task 2) quantizes elevation into discrete bands
 * (`TERRACE_BAND_M`, `quantizeBands` in `./worldMesh.ts`) before
 * displacement, flat-shaded, producing a stepped "rice-terrace" contour on
 * the same shared-vertex mesh; `voxel` (Task 3/4) rebuilds each tile as
 * extruded, flat-topped blocks (`buildVoxelBlocks` in `./worldMesh.ts`,
 * `VOXEL_CELLS_PER_EDGE`/`VOXEL_BAND_M` below) — the base or region variant
 * depending on whether a region patch is already cached for that tile — with
 * per-cell cliff walls where a neighbor's band is lower. Selecting it is
 * exposed on the HUD by a later task; the switch itself never throws. */
export type GlobeStyle = 'smooth' | 'voxel' | 'terraced' | 'faceted';

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
  /** Show or hide the ocean-current advection overlay (The Gyre) — a no-op
   * when `createCurrents` built nothing to show (no ocean-current data). */
  setCurrents(on: boolean): void;
  /** Show or hide the cloud advection overlay (The Rains) — a no-op when
   * `createClouds` built nothing to show (a locked world has no wind to
   * advect along, or no tile clears the cloud-fraction threshold). */
  setClouds(on: boolean): void;
  /** Show or hide the ocean's drifting wave pattern (the normal map). Off
   * leaves a smooth, still sea; the depth grading stays. */
  setWaves(on: boolean): void;
  /** Turn the ocean's sun-glint (specular highlight) on or off. Independent
   * of the waves toggle. */
  setGlint(on: boolean): void;
  /** Fill the night side with ambient light (on) so the unlit hemisphere is
   * readable, or leave the honest dark terminator (off, the default). */
  setNightFill(on: boolean): void;
  /** A requested region patch (true higher-res terrain) arrived for the tile
   * `key`: cache it and let the next frame rebuild that tile from it. */
  onRegion(key: string, region: RegionScene): void;
  /** A requested region patch failed for the tile `key`: the tile keeps its
   * interpolated form, and the request scheduler frees the slot it was
   * holding (retrying a bounded number of times before giving up). */
  onRegionError(key: string): void;
  /** Toggle the seasonal hold (Task 9): freezes the mesh's diurnal spin
   * (`spinGroup.rotation.z`, via `seasonalSpinZ`) while the terminator light
   * keeps tracking the sub-solar latitude, so a year's seasons are watchable
   * at the fast clock rates without the daily spin blurring the picture.
   * `main.ts` engages it once the active clock mult crosses the old
   * (pre-Task-8) globe cap. Off by default, matching today's spin. */
  setSeasonalHold(on: boolean): void;
  /** Toggle Task 6's "watch a day" hold: pins the temperature lens' season
   * (the year-phase term, and thus the mean+swing baseline and the diurnal
   * pulse's declination) at the day last painted, while the diurnal pulse's
   * own day fraction keeps tracking the live clock — composes with
   * `setSeasonalHold` rather than fighting it (that one freezes the mesh's
   * visual spin only; this one freezes the season only, orthogonal state).
   * Off by default, matching today's un-pinned season. */
  setDayHold(on: boolean): void;
  /** Switch the render style: `faceted` flat-shades the surface material in
   * place (no rebuild); `terraced` (Task 2) rebuilds every mounted tile with
   * its elevation quantized into bands, flat-shaded; `voxel` is still
   * smooth-geometry-for-now until its own task lands — the switch is always
   * safe, never throws. */
  setStyle(style: GlobeStyle): void;
}

/** Diff two tile-leaf sets by key: `added` are `next` tiles whose key was not
 * in `prevKeys` (a fresh split's new children, or a fresh merge's new
 * parent), `removed` are `prevKeys` not present in `next` (the tiles that
 * just went away), `keptCount` is how many tiles are unchanged. Pure — no
 * scene-graph access — so the incremental LOD path (`reselect`/`applyTileSet`
 * below) can dispose only `removed`, build only `added`, and leave every kept
 * tile's mesh/geometry/colours completely untouched. */
export function diffTileSets(
  prevKeys: Set<string>,
  next: TileId[],
): { added: TileId[]; removed: string[]; keptCount: number } {
  const nextKeys = new Set<string>();
  const added: TileId[] = [];
  let keptCount = 0;
  for (const t of next) {
    const key = tileKey(t);
    nextKeys.add(key);
    if (prevKeys.has(key)) keptCount++;
    else added.push(t);
  }
  const removed: string[] = [];
  for (const key of prevKeys) {
    if (!nextKeys.has(key)) removed.push(key);
  }
  return { added, removed, keptCount };
}

/** The tile in `currentByKey` (a previous leaf selection, keyed by
 * `tileKey`) that covers `t`'s position at-or-coarser-than `t`'s own level:
 * `t` itself if it was already a leaf, else the nearest ancestor that was —
 * walking up the quadtree until a hit or the root. `null` only if `t`'s
 * position was previously covered by FINER tiles (a coarsening region), where
 * no ancestor-or-self of `t` was ever a leaf. */
function coveringLeaf(t: TileId, currentByKey: Map<string, TileId>): TileId | null {
  let cur: TileId | null = t;
  while (cur) {
    const hit = currentByKey.get(tileKey(cur));
    if (hit) return hit;
    cur = parentTile(cur);
  }
  return null;
}

/** On-settle refinement: while the camera is still moving, hold `target`'s
 * *refining* changes (splits — a tile going finer than it currently is) back
 * at their current coarser tile, but let its *coarsening* changes (merges —
 * always cheap, and camera-out is exactly when detail should drop) through
 * immediately. Pure — `currentLeaves`/`target` are both plain leaf-set
 * snapshots. A target leaf whose position was already at-or-coarser-than its
 * covering current tile passes through unchanged; a would-be-finer leaf is
 * replaced by its covering (coarser) current tile, deduplicated so the
 * result stays a valid non-overlapping leaf set. */
export function gateRefinement(currentLeaves: TileId[], target: TileId[]): TileId[] {
  const currentByKey = new Map(currentLeaves.map((t) => [tileKey(t), t] as const));
  const out: TileId[] = [];
  const usedKeys = new Set<string>();
  for (const t of target) {
    const cover = coveringLeaf(t, currentByKey);
    const chosen = cover !== null && cover.level < t.level ? cover : t;
    const key = tileKey(chosen);
    if (!usedKeys.has(key)) {
      out.push(chosen);
      usedKeys.add(key);
    }
  }
  return out;
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
  requestRegion?: (tile: TileId) => void,
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

  // The globe's surface is a per-tile-CDLOD set of cube-sphere tiles at varying
  // levels (fine near the camera, coarse far away — `selectTiles`). Level 0 is
  // a whole face, each deeper level a 2×2 subdivision. Everything downstream is
  // keyed by tile SLOT, not face — the per-vertex tile-index cache, the base
  // colours, the repaint, the relief rebuild — so a rebuild at any mix of
  // levels Just Works; skirts fill the cracks at mixed-level boundaries.
  let currentSelected: TileId[] = [];
  let reliefOn = false; // true-relief (1×) vs schematic (RELIEF_EXAGGERATION×)
  const reliefScale = (): number => (reliefOn ? 1 : RELIEF_EXAGGERATION);
  // The render-style axis (The Massing): declared here, ahead of
  // `buildTileSlot` below, which reads it — a `let` declared after its first
  // read would throw (temporal dead zone). `bandM()` is `buildTileSlot`'s
  // single source of truth for whether a tile bands its elevation (Terraced)
  // or stays continuous (everything else, including today's Smooth).
  let activeStyle: GlobeStyle = 'smooth';
  const bandM = (): number | undefined => (activeStyle === 'terraced' ? TERRACE_BAND_M : undefined);

  // Region patches (true higher-res terrain): cached by tile key, requested
  // async through the worker. Gated to spinning worlds (the locked-temperature
  // lens needs width/height a region patch lacks) — a locked world renders
  // from the export alone at every level, exactly as it does today.
  const regionsEnabled = requestRegion !== undefined && sys.world.dayLengthDays !== null;
  // Every level is region-served now (The Cascade): the base globe is built
  // from patches rather than resampled from the tiles export, so the export's
  // width stops bounding the globe's detail. 0 rather than LOD_MIN_LEVEL
  // because no rendered tile is ever coarser than the base — this says "every
  // tile the globe can show wants its own patch" without restating the base.
  const REGION_MIN_LEVEL = 0;
  // …and therefore the BASE level follows `regionsEnabled` too. LOD_MIN_LEVEL
  // (2, i.e. 96 tiles / a 1024-column lattice) is sized for a globe whose
  // tiles get replaced by real patches. A locked world never receives one, so
  // that lattice would resample the same 512-column export onto 4× the
  // vertices: 4× the build time and geometry memory for zero additional
  // information, and permanently bilinear-synthesized relief between real
  // samples. That is interpolation dressed as detail — precision the producer
  // never shipped — which is exactly what decision 0022 forbids. Level 1 (24
  // tiles / 512 columns) is matched to the export a locked world actually has.
  const baseLevel = regionsEnabled ? LOD_MIN_LEVEL : 1;
  const regionCache = new Map<string, RegionScene>();
  // Region requests go through the cascade scheduler rather than firing inline
  // at build time: it owns the dedupe (so a tile rebuilt every frame is asked
  // for once), orders them camera-facing-first, and caps how many are
  // outstanding — a camera move re-prioritizes what has not been asked for yet
  // instead of waiting out a stale queue.
  const cascade = createCascade();
  // A region tile's colour index is just its node index (0..n²-1) — one shared
  // identity map for all region tiles (read-only in the repaint).
  const identityIdx = Int32Array.from({ length: tileGridN * tileGridN }, (_, i) => i);
  // A region that arrived for a tile still shown as a base tile (its key is
  // otherwise unchanged, so the incremental diff below would never touch it):
  // `onRegion` marks it here, and the next `reselect` upgrades it in place.
  const pendingUpgrades = new Set<string>();

  /** One rendered tile's complete state: the mesh mounted in `spinGroup`, its
   * geometry, the per-vertex tile-index cache (`idx`: the base `tileIndex`
   * map for a base tile, `identityIdx` for a region tile — a node's index IS
   * its colour index there), the colour SOURCE (`tiles` or, cast, a region
   * patch — its own per-node fields carry the same names the lens reads), and
   * `baseColor` (the active lens's static per-vertex colour, rebuilt on
   * `setLens`; for a living lens this is the day-0 snapshot `repaint`
   * overwrites, for a static one it IS the final colour modulo the ice
   * blend). Keyed by `tileKey` in `tileSlots` below — the incremental LOD
   * diff disposes/builds individual slots instead of the whole set. */
  interface TileSlot {
    id: TileId;
    mesh: THREE.Mesh;
    geom: THREE.BufferGeometry;
    idx: Int32Array;
    colorSrc: TilesScene;
    baseColor: Float32Array;
    /** True iff this slot is a mounted region patch (higher-res terrain), not
     * a base tile. Region patches need a scoped normal stitch across their
     * shared edges (`stitchMountedRegions`); base tiles never do. */
    isRegion: boolean;
    /** The Voxel style's per-vertex color multiplier (`undefined` for every
     * other style): 1 for a top-face vertex, `VOXEL_CLIFF_DARKEN` for a
     * wall (cliff) vertex — `paintSlot` applies it as the last step so a
     * living-lens repaint keeps a cell's wall exactly as dark relative to
     * its own top as the geometry was originally built, without a full
     * geometry rebuild on every repaint. */
    darken?: Float32Array;
  }
  const tileSlots = new Map<string, TileSlot>();

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

  function computeBaseColor(idx: Int32Array, src: TilesScene): Float32Array {
    const buf = new Float32Array(idx.length * 3);
    for (let v = 0; v < idx.length; v++) {
      const rgb = activeLens.colorAt(src, idx[v]!, lastDay ?? 0, seasonalCtx);
      buf[3 * v] = rgb[0] / 255;
      buf[3 * v + 1] = rgb[1] / 255;
      buf[3 * v + 2] = rgb[2] / 255;
    }
    return buf;
  }

  /** Recompute every mounted slot's `baseColor` for the (just-changed)
   * active lens — the per-slot counterpart of the old whole-set rebuild,
   * called from `setLens`. */
  function rebuildBase(): void {
    for (const slot of tileSlots.values()) slot.baseColor = computeBaseColor(slot.idx, slot.colorSrc);
  }

  // A skirt deep enough to cover the worst crack at a mixed-LOD boundary: the
  // crack can be as tall as the relief displacement, which is bounded by
  // radius·scale·(maxElevation / referenceRadius); this is a generous multiple
  // of that (the skirt hides below the surface, so over-deep costs nothing).
  const skirtDepthFor = (scale: number): number => GLOBE_RADIUS * scale * 0.0025;

  /** A stable signature of a leaf-tile set, for cheap change detection. */
  const signatureOf = (set: TileId[]): string => set.map(tileKey).join('|');
  let currentSignature = '';

  /** Build one tile's complete slot at `scale`: base data or (once cached) a
   * region patch, mounted into `spinGroup`. Does not touch any other slot —
   * this is the unit the incremental diff below adds/removes one of at a
   * time, instead of the old whole-set rebuild. */
  function buildTileSlot(t: TileId, scale: number): TileSlot {
    // How many tile geometries have actually been built (same globalThis
    // instrumentation pattern as `__btCount`/`__swapCount`/`__btMs`). Tests
    // read it to assert that a whole-globe event ENQUEUES rather than builds:
    // the count must not move across `setStyle`/`setTrueRelief` itself, and
    // must move by at most MAX_BUILDS_PER_FRAME per pumped frame after.
    const bc = globalThis as { __slotBuildCount?: number };
    bc.__slotBuildCount = (bc.__slotBuildCount ?? 0) + 1;
    const key = tileKey(t);
    const skirt = skirtDepthFor(scale);
    const wantsRegion = regionsEnabled && t.level >= REGION_MIN_LEVEL;
    const region = wantsRegion ? regionCache.get(key) : undefined;
    let geom: THREE.BufferGeometry;
    let colorSrc: TilesScene;
    let idx: Int32Array;
    let darken: Float32Array | undefined;
    if (activeStyle === 'voxel') {
      // Extruded flat-topped blocks (worldMesh.ts's shared `buildVoxelBlocks`
      // algorithm) instead of the shared-vertex smooth/terraced mesh — the
      // region variant when a higher-res patch is already cached for this
      // tile, the base (tiles-export) variant otherwise, exactly mirroring
      // the smooth/terraced branch below. No skirt (voxel walls seal the
      // silhouette on their own — see `buildVoxelBlocks`'s doc comment).
      const voxelOpts = { cellsPerEdge: VOXEL_CELLS_PER_EDGE, bandM: VOXEL_BAND_M };
      if (region) {
        const built = buildVoxelRegionTileGeometryIndexed(
          region,
          GLOBE_RADIUS,
          scale,
          (node) => activeLens.colorAt(region as unknown as TilesScene, node, lastDay ?? 0, seasonalCtx),
          voxelOpts,
        );
        geom = built.geom;
        idx = built.index;
        darken = built.darken;
        colorSrc = region as unknown as TilesScene;
      } else {
        const built = buildVoxelTileGeometryIndexed(tiles, t, GLOBE_RADIUS, scale, colorAt, voxelOpts);
        geom = built.geom;
        idx = built.index;
        darken = built.darken;
        colorSrc = tiles;
        // Ask for the region if it would sharpen this tile — the same request
        // path the smooth/terraced branch uses below, so a deep voxel tile
        // still upgrades to true higher-res terrain. Submitting is cheap and
        // idempotent; `update` deals the actual requests.
        if (wantsRegion) cascade.submit([t]);
      }
    } else if (region) {
      // True higher-res terrain, coloured by the lens on the region's own
      // nodes (RegionScene carries the fields colorAt reads).
      geom = buildRegionTileGeometry(
        region,
        GLOBE_RADIUS,
        scale,
        (node) => activeLens.colorAt(region as unknown as TilesScene, node, lastDay ?? 0, seasonalCtx),
        skirt,
        bandM(),
      );
      colorSrc = region as unknown as TilesScene;
      idx = identityIdx;
    } else {
      geom = buildTileGeometry(tiles, t, GLOBE_RADIUS, scale, colorAt, skirt, bandM());
      colorSrc = tiles;
      const grid = tileGrid(t);
      // Only the surface vertices (n×n) are lens-recoloured; the skirt copies
      // its edge vertex's colour at build time and is never a data surface.
      idx = new Int32Array(tileGridN * tileGridN);
      for (let i = 0; i < idx.length; i++) idx[i] = tileIndex(tiles, grid.lats[i]!, grid.lons[i]!);
      // Ask for the region if it would sharpen this tile (see above).
      if (wantsRegion) cascade.submit([t]);
    }
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `globe-tile-${key}`;
    spinGroup.add(mesh);
    return {
      id: t,
      mesh,
      geom,
      idx,
      colorSrc,
      baseColor: computeBaseColor(idx, colorSrc),
      isRegion: region !== undefined,
      darken,
    };
  }

  /** Reconcile normals across the mounted REGION patches so their shared
   * edges do not draw a shading seam (worldMesh `stitchNormals`, and its doc,
   * for why base tiles don't need this and region tiles do). Scoped to the
   * handful of region tiles on screen at deep zoom — never the whole globe.
   * Idempotent for a fixed set; both sides of every shared edge come out
   * with the identical normal, which is what removes the crease.
   *
   * A no-op under the Voxel style: `stitchNormals` averages the normals of
   * every geometry's vertices at a shared 3D position, which is exactly
   * right for the smooth/terraced builders' per-VERTEX analytic normals but
   * wrong for voxel's per-CELL flat normals — two adjacent tiles' boundary
   * cells share their corner *positions* (same cube-sphere addressing) but
   * are different blocks with deliberately different flat normals; blending
   * them would smear the blocky look Task 3 built voxel to have. Voxel
   * accepts the same bounded per-tile-boundary seam its base builder already
   * documents, rather than smoothing across it. */
  function stitchMountedRegions(): void {
    if (activeStyle === 'voxel') return;
    const regionGeoms: THREE.BufferGeometry[] = [];
    for (const slot of tileSlots.values()) if (slot.isRegion) regionGeoms.push(slot.geom);
    if (regionGeoms.length > 1) stitchNormals(regionGeoms);
  }

  /** Dispose+unmount one slot, if present. The other half of `buildTileSlot`
   * — together these are the whole incremental unit (no global stitch: T2's
   * analytic normals already made same-level neighbours agree by
   * construction, so one tile's geometry never depends on another's). */
  function disposeSlot(key: string): void {
    const slot = tileSlots.get(key);
    if (!slot) return;
    spinGroup.remove(slot.mesh);
    slot.geom.dispose();
    tileSlots.delete(key);
  }

  /** Paint one slot's vertex colours for `day`: the active lens (living or
   * `slot.baseColor`'s snapshot), ice-blended only under `natural`, darkened
   * last for a voxel wall vertex (`slot.darken`, `undefined` for every other
   * style — see `TileSlot`'s doc comment). Applying `darken` AFTER the ice
   * blend (rather than baking it into `base`) is what lets a voxel slot's
   * repaint recolor a wall correctly without a full geometry rebuild: the
   * SAME per-vertex loop that already recolors a smooth/terraced tile's
   * vertices also recolors a voxel tile's, it just additionally scales a
   * wall vertex's final colour by its cell's darken multiplier. Shared by
   * the full `repaint` below and the incremental path's targeted repaint of
   * just-built slots. */
  function paintSlot(slot: TileSlot, day: number, icy: boolean): void {
    const color = slot.geom.getAttribute('color') as THREE.BufferAttribute;
    const idx = slot.idx;
    const base = slot.baseColor;
    const src = slot.colorSrc;
    const darken = slot.darken;
    for (let v = 0; v < idx.length; v++) {
      let r: number, g: number, b: number;
      if (activeLens.dependsOnDay) {
        const rgb = activeLens.colorAt(src, idx[v]!, day, seasonalCtx);
        r = rgb[0] / 255;
        g = rgb[1] / 255;
        b = rgb[2] / 255;
      } else {
        r = base[3 * v]!;
        g = base[3 * v + 1]!;
        b = base[3 * v + 2]!;
      }
      if (icy) {
        const frac = iceFraction(src, idx[v]!, day, seasonalCtx);
        r += (ICE_COLOR[0] - r) * frac;
        g += (ICE_COLOR[1] - g) * frac;
        b += (ICE_COLOR[2] - b) * frac;
      }
      if (darken) {
        const d = darken[v]!;
        r *= d;
        g *= d;
        b *= d;
      }
      color.setXYZ(v, r, g, b);
    }
    color.needsUpdate = true;
  }

  /** Repaints every mounted slot for `day`: the active lens's colour per
   * vertex, blended toward `ICE_COLOR` only under `natural` (a data lens must
   * show its data, not decorative ice — the blend would corrupt its colormap).
   * Repaints only when the day actually moved, or when forced (a lens swap or
   * a full tile rebuild). A static, non-natural lens (no ice, no day
   * dependency) repaints once and never again. */
  function repaint(day: number, force = false): void {
    const still = !activeLens.dependsOnDay && activeLens.id !== naturalLens.id;
    if (!force && day === lastDay) return;
    if (!force && still && lastDay !== null) return;
    lastDay = day;
    const icy = activeLens.id === naturalLens.id;
    for (const slot of tileSlots.values()) paintSlot(slot, day, icy);
  }

  /** Repaint only the given (already-built) slots at the last-committed day
   * — used right after the incremental diff adds/upgrades tiles, so they
   * pick up the ice blend and any living-lens colour without touching (or
   * even visiting) every other tile already on screen. */
  function repaintSlots(keys: string[]): void {
    const day = lastDay ?? 0;
    const icy = activeLens.id === naturalLens.id;
    for (const key of keys) {
      const slot = tileSlots.get(key);
      if (slot) paintSlot(slot, day, icy);
    }
  }

  // Amortized build: a leaf-set change would build up to ~36 tiles at once
  // (measured worst case ~69ms — several dropped frames, felt as a hitch on
  // every LOD change). Instead `applyTileSet` only RECONCILES — it disposes
  // nothing that would leave a hole, enqueues the tiles to build, and marks
  // the now-undesired ones "retiring" — while `drainBuildQueue` (called every
  // frame from `update`) builds only a few tiles per frame under a time
  // budget. A big refine then sharpens progressively over ~10 frames instead
  // of freezing one; a spin's few-tile churn never busts a frame either.
  const buildQueue: TileId[] = [];
  const queuedKeys = new Set<string>();
  const swapQueued = new Set<string>(); // queued keys that are region swaps (for __swapCount)
  // Mounted tiles no longer desired, kept RENDERED until the finer/coarser
  // tiles that replace them are built — deferring disposal is what prevents a
  // hole (a disposed split-parent with its children not yet built) opening
  // mid-refinement.
  const retiringKeys = new Set<string>();
  let regionDirtyPending = false; // a region tile built/left since the last stitch
  const BUILD_BUDGET_MS = 5; // per-frame time budget (governs production pacing)
  const MAX_BUILDS_PER_FRAME = 6; // hard count cap (governs when builds are ~free, e.g. tests)
  // The camera direction the drain orders by, in the globe's LOCAL frame (the
  // tiles live under `spinGroup`) — written by `reselect`, which computes that
  // frame for the selection anyway. Mutated in place rather than reassigned so
  // a per-frame sort costs no allocation.
  const buildCam: V3 = [0, 0, 0];
  let buildCamKnown = false; // until the first camera-ful frame: queue order

  /** Publish the build queue's depth (same `globalThis` instrumentation pattern
   * as `__btCount`/`__swapCount`/`__slotBuildCount`). `0` means every tile the
   * current leaf set wants is MOUNTED — the readiness signal an out-of-process
   * driver (e2e) polls instead of sleeping a fixed number of milliseconds after
   * a style switch or a refine. Since the builds are paced at
   * `MAX_BUILDS_PER_FRAME`, "how long a rebuild takes" is a frame count, not a
   * wall-clock duration, and any fixed sleep is a bet on frame rate.
   *
   * Deliberately the QUEUE only, not `retiringKeys`: a retiring tile is still
   * rendered (that is the point of deferring its disposal), so it never blocks
   * visual readiness — and `coveringMounted` can strand one (it only looks one
   * level up/down), which would make a signal that counted them never reach 0.
   *
   * Written wherever the queue's depth changes — the two enqueue sites and the
   * drain — so it is correct SYNCHRONOUSLY with the call that enqueues, not
   * only from the next animation frame. A driver that polls right after
   * `setStyle` must not read a stale `0` from the previous frame's drain. */
  function noteBuildPending(): void {
    (globalThis as { __buildPending?: number }).__buildPending = buildQueue.length;
  }

  const keyToTile = (key: string): TileId => {
    const [face, level, ix, iy] = key.split(':').map(Number) as [number, number, number, number];
    return { face, level, ix, iy };
  };
  /** A retiring tile may be disposed only once everything that covers its area
   * is mounted: its selected children (a split) all built, or its nearest
   * selected ancestor (a merge) built. Until then it stays on screen. */
  function coveringMounted(r: TileId, selectedKeys: Set<string>, mounted: Set<string>): boolean {
    const kids = childTiles(r).map(tileKey).filter((k) => selectedKeys.has(k));
    if (kids.length > 0) return kids.every((k) => mounted.has(k));
    for (let p = parentTile(r); p !== null; p = parentTile(p)) {
      const pk = tileKey(p);
      if (selectedKeys.has(pk)) return mounted.has(pk);
    }
    return true; // no covering tile desired (fully removed) — safe to dispose
  }

  /** Reconcile the desired leaf set against what's mounted/queued: enqueue
   * tiles to build, mark undesired ones retiring (disposed later, hole-free),
   * and register any region swap. Builds nothing here — `drainBuildQueue`
   * does, a few tiles per frame. `reselect` calls this once per leaf-set
   * change; the harness's `__btCount` counts those changes. */
  function applyTileSet(selected: TileId[]): void {
    const t0 = performance.now();
    const selectedKeys = new Set(selected.map(tileKey));
    // Mounted-but-undesired → retiring (kept rendered); desired-again → un-retire.
    for (const key of tileSlots.keys()) if (!selectedKeys.has(key)) retiringKeys.add(key);
    for (const key of selectedKeys) retiringKeys.delete(key);
    // Drop queued tiles no longer desired (the camera moved on before they built).
    for (let i = buildQueue.length - 1; i >= 0; i--) {
      const key = tileKey(buildQueue[i]!);
      if (!selectedKeys.has(key)) {
        buildQueue.splice(i, 1);
        queuedKeys.delete(key);
        swapQueued.delete(key);
      }
    }
    // Enqueue desired tiles neither mounted nor already queued.
    for (const t of selected) {
      const key = tileKey(t);
      if (!tileSlots.has(key) && !queuedKeys.has(key)) {
        buildQueue.push(t);
        queuedKeys.add(key);
      }
    }
    // A region that arrived for an already-mounted (base) tile: enqueue a
    // same-key rebuild — its old base slot is disposed and replaced atomically
    // when built, so it never leaves a hole and needs no retiring entry.
    if (pendingUpgrades.size > 0) {
      for (const t of selected) {
        const key = tileKey(t);
        if (pendingUpgrades.has(key) && tileSlots.has(key) && !queuedKeys.has(key)) {
          buildQueue.push(t);
          queuedKeys.add(key);
          swapQueued.add(key);
        }
      }
      pendingUpgrades.clear();
    }
    currentSelected = selected;
    currentSignature = signatureOf(selected);
    noteBuildPending();
    const g = globalThis as { __btCount?: number; __btMs?: number };
    g.__btCount = (g.__btCount ?? 0) + 1;
    g.__btMs = (g.__btMs ?? 0) + (performance.now() - t0);
  }

  /** Queue a rebuild of the whole current leaf set, for the two whole-globe
   * events where every tile's geometry changes without the leaf SET changing:
   * a relief-scale toggle (`setTrueRelief`) and a style change that crosses
   * geometry families (`setStyle` — smooth↔terraced↔voxel). Never the
   * per-frame LOD path (`applyTileSet` above, which the incremental
   * diff/harness covers).
   *
   * Builds nothing here. Every selected tile is enqueued as a SAME-KEY
   * rebuild — exactly the shape `pendingUpgrades` already uses for a region
   * arriving under a mounted base tile: `drainBuildQueue` disposes the old
   * slot and installs the new one in the same step, so the tile is never
   * absent and needs no `retiringKeys` deferral (these tiles are not being
   * retired; they are being re-cut in place). Doing it synchronously instead
   * froze the main thread for seconds once the base set reached 6·4² = 96
   * tiles.
   *
   * The new style/relief is picked up because `buildTileSlot` reads
   * `activeStyle`/`bandM()` live and `drainBuildQueue` re-reads
   * `reliefScale()` each frame — a queued rebuild builds from the values in
   * force when it BUILDS, not when it was enqueued. Callers therefore mutate
   * `reliefOn`/`activeStyle` first, then enqueue. */
  function enqueueRebuildAll(): void {
    for (const t of currentSelected) {
      const key = tileKey(t);
      // Already queued (an undrained initial mount, or a pending region swap):
      // that build will pick up the new style/relief on its own.
      if (queuedKeys.has(key)) continue;
      buildQueue.push(t);
      queuedKeys.add(key);
    }
    noteBuildPending();
  }

  /** Build a few queued tiles under a per-frame time budget, then dispose any
   * retiring tiles whose replacements are now all mounted. Called every frame
   * from `update`. This is the amortization — no single frame builds the whole
   * refine. Re-stitches the region set only once the queue has drained (a
   * region tile changed), never mid-drain. */
  function drainBuildQueue(): void {
    const t0 = performance.now();
    // Per-frame time budget. Overridable via a globalThis hook (same
    // instrumentation pattern as `__btMs`/`__swapCount`) so tests can lift the
    // TIME limit and let the count cap (`MAX_BUILDS_PER_FRAME`) govern the drain
    // rate deterministically — otherwise a slow CI box drains ~1 tile/frame and
    // a fixed pump can't finish the (LOD-deep) queue that a fast dev box drains
    // in the same frames. The count cap stays intact, so progressive-drain
    // behaviour is unchanged; only the wall-clock sensitivity is removed.
    const budgetMs = (globalThis as { __buildBudgetMs?: number }).__buildBudgetMs ?? BUILD_BUDGET_MS;
    if (buildQueue.length > 0) {
      // Camera-facing first — the same ordering `cascade.ts` applies to region
      // REQUESTS, here applied to the builds those patches feed. It matters for
      // the same reason and more sharply: the budget above buys ONE build per
      // frame on a slow box, so a 96-tile base mount spans ~96 frames, and in
      // queue order (face 0 through face 5) the surface under the camera can be
      // the last thing to arrive — the globe fills in from behind, and until it
      // does there is nothing to look at and nothing for the inspector's
      // raycast to hit. Sorting the whole queue each frame, rather than only on
      // enqueue, is what lets a camera move re-aim the remaining builds; at
      // ≤ a few hundred tiles it does not register against one tile's build.
      if (buildCamKnown && buildQueue.length > 1) sortCameraFacingFirst(buildQueue, buildCam);
      const scale = reliefScale();
      const built: string[] = [];
      let swaps = 0;
      do {
        const t = buildQueue.shift()!;
        const key = tileKey(t);
        queuedKeys.delete(key);
        if (swapQueued.delete(key)) swaps++;
        disposeSlot(key); // no-op unless this is a base→region swap in place
        const slot = buildTileSlot(t, scale);
        tileSlots.set(key, slot);
        if (slot.isRegion) regionDirtyPending = true;
        built.push(key);
      } while (buildQueue.length > 0 && built.length < MAX_BUILDS_PER_FRAME && performance.now() - t0 < budgetMs);
      if (built.length > 0) repaintSlots(built);
      noteBuildPending();
      if (swaps > 0) {
        const g = globalThis as { __swapCount?: number };
        g.__swapCount = (g.__swapCount ?? 0) + swaps;
      }
    }
    // Dispose retiring tiles whose covering replacements are now all mounted.
    if (retiringKeys.size > 0) {
      const selectedKeys = new Set(currentSelected.map(tileKey));
      const mounted = new Set(tileSlots.keys());
      for (const rk of [...retiringKeys]) {
        if (coveringMounted(keyToTile(rk), selectedKeys, mounted)) {
          if (tileSlots.get(rk)?.isRegion) regionDirtyPending = true;
          disposeSlot(rk);
          retiringKeys.delete(rk);
        }
      }
    }
    // Region stitch only when the set is stable (queue drained, none retiring).
    if (regionDirtyPending && buildQueue.length === 0 && retiringKeys.size === 0) {
      stitchMountedRegions();
      regionDirtyPending = false;
    }
    const g = globalThis as { __btMs?: number };
    g.__btMs = (g.__btMs ?? 0) + (performance.now() - t0);
  }

  // Initial base set, amortized exactly like any later refine: reconcile the
  // desired set (which enqueues every tile) — no explicit drain here. The
  // trailing `update(0)` below (this function's last statement) is a normal
  // camera-less tick, and that already calls `drainBuildQueue` once, which is
  // what makes omitting a drain here safe: the whole base set is enqueued and
  // its first `MAX_BUILDS_PER_FRAME` tiles are built before the view is
  // returned. Adding a second explicit drain would build two frames' worth (up
  // to 2×MAX_BUILDS_PER_FRAME) instead. Building the whole set synchronously
  // (the whole-set rebuild this queue replaced) would hitch — at base level
  // 2 that is 96 tiles in one synchronous burst. The rest arrive over the
  // following frames via `update` → `drainBuildQueue`.
  const baseSet = tilesAtLevel(baseLevel);
  // Seed the cascade with the WHOLE base set up front, ahead of the builds
  // that would each submit their own tile from `buildTileSlot`. Both routes
  // reach the same scheduler and `submit` dedupes, so this changes nothing
  // about WHICH tiles are requested — only the order they can be requested
  // in. Submitting per-build would leave the queue holding only the handful
  // of tiles drained so far, so the first `reprioritize` would have almost
  // nothing to sort and the camera-facing-first ordering (spec §4.2) would
  // degrade to build order (face-major) for the first frames. With all 96 in
  // hand the very first camera frame deals the tiles the user is looking at.
  if (regionsEnabled) cascade.submit(baseSet);
  applyTileSet(baseSet);

  // On-settle refinement (spec §2, Nathan-approved): while the camera moved
  // more than SETTLE_EPSILON since last frame, `reselect` defers *refining*
  // changes (a split — going finer) via `gateRefinement`, holding the current
  // coarser tile instead; *coarsening* (merging on zoom-out) is always cheap
  // and applied immediately either way. Refinement resumes once motion has
  // been below the epsilon for SETTLE_FRAMES_NEEDED consecutive frames — "a
  // frame or two", so a fling holds its detail steady instead of rebuilding
  // every frame it's in flight. Both constants are tunable; the controller's
  // visual pass confirms the feel (a lag that reads as sluggish vs one that
  // reads as settling).
  const SETTLE_EPSILON = GLOBE_RADIUS * 0.0015;
  const SETTLE_FRAMES_NEEDED = 2;
  // The settle gate tracks the USER's camera in WORLD space — deliberately not
  // the spun `localCam` below. The globe's own diurnal spin advances
  // `spinGroup.rotation.z` every frame under autoplay, so a camera re-expressed
  // in the spinning frame is never still while the clock runs; keying settle off
  // it would hold refinement forever and the globe would never sharpen past the
  // coarse set while time plays. The user's world-space camera pose is what a
  // "fling" actually moves, and it is stationary the instant they stop.
  let prevCamWorld: THREE.Vector3 | null = null;
  let settledFrames = 0;

  const localCam = new THREE.Vector3(); // reselect scratch — no per-frame alloc
  const cascadeCam = new THREE.Vector3(); // cameraUnitFor scratch, kept separate
  // so a cascade call can never alias `reselect`'s in-flight `localCam`
  const spinZAxis = new THREE.Vector3(0, 0, 1);
  /** The camera in the spinning globe's LOCAL frame, written into `out` — the
   * tiles live under `spinGroup`, so everything that reasons about which
   * surface the camera faces (selection, region priority) must work here. */
  function toLocalFrame(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(camera.position).applyAxisAngle(spinZAxis, -spinGroup.rotation.z);
  }
  /** The same local frame as a unit direction — what the cascade scores tile
   * centre units against (dot product), so its ordering follows the surface
   * facing the camera as the world turns. */
  function cameraUnitFor(camera: THREE.Camera): V3 {
    const p = toLocalFrame(camera, cascadeCam);
    const len = p.length() || 1;
    return [p.x / len, p.y / len, p.z / len];
  }
  /** Per-tile CDLOD: transform the camera into the spinning globe's local
   * frame (the tiles live under `spinGroup`, rotated by rotation.z), select
   * the leaf-tile set for that closeness (with merge hysteresis against the
   * last-applied set), gate refinement while the camera is still moving, and
   * apply the result incrementally only if it actually changed. */
  function reselect(camera: THREE.Camera): void {
    // Settle on the user's world-space camera motion (see `prevCamWorld`).
    const moved = prevCamWorld === null || camera.position.distanceTo(prevCamWorld) > SETTLE_EPSILON;
    settledFrames = moved ? 0 : settledFrames + 1;
    if (prevCamWorld === null) prevCamWorld = camera.position.clone();
    else prevCamWorld.copy(camera.position);

    // Tile SELECTION uses the camera in the spinning globe's local frame (the
    // tiles live under `spinGroup`); as the world turns, this sweeps and the
    // leaf set follows the surface now facing the camera.
    toLocalFrame(camera, localCam);
    // Hand the drain the same local-frame direction the selection just used,
    // so this frame's builds are spent on the surface the camera is looking at.
    const camLen = localCam.length() || 1;
    buildCam[0] = localCam.x / camLen;
    buildCam[1] = localCam.y / camLen;
    buildCam[2] = localCam.z / camLen;
    buildCamKnown = true;
    const target = selectTiles(
      [localCam.x, localCam.y, localCam.z],
      GLOBE_RADIUS,
      LOD_SPLIT_FACTOR,
      LOD_CDLOD_MAX_LEVEL,
      baseLevel, // follows `regionsEnabled` — see its declaration
      { mergeFactor: LOD_MERGE_FACTOR, splitAncestors: splitAncestorKeys(currentSelected) },
    );
    const settled = settledFrames >= SETTLE_FRAMES_NEEDED;
    const selected = settled ? target : gateRefinement(currentSelected, target);
    if (signatureOf(selected) !== currentSignature || pendingUpgrades.size > 0) applyTileSet(selected);
  }

  function onRegion(key: string, region: RegionScene): void {
    cascade.settle(keyToTile(key), true); // the patch arrived: free the slot, retire the tile
    attachNodeCoords(region);
    regionCache.set(key, region);
    // The tile at `key` may currently be mounted as a base-data slot (same
    // key either way — the leaf selection didn't change) — mark it so the
    // next `reselect` upgrades that one slot to the now-cached region detail,
    // without a full rebuild. Naturally debounced: several arrivals before
    // the next frame still cost one upgrade each, not a wholesale rebuild.
    pendingUpgrades.add(key);
  }

  /** Give a freshly-arrived patch its per-node geography.
   *
   * A region's nodes are a cube-sphere tile's own lattice, so unlike the
   * equirect export their coordinates do not follow from a linear index — but
   * they ARE fully determined by the tile address the patch already carries.
   * The temperature lens needs them for its diurnal term (which is phased by
   * local solar time, i.e. by longitude), so compute them once here rather
   * than per-vertex on every repaint. Mutating the document on arrival keeps
   * `RegionScene`'s cast to `TilesScene` (the lens' colour SOURCE) honest:
   * both shapes now answer the same question the same way. */
  function attachNodeCoords(region: RegionScene): void {
    const units = regionPatchUnits(region);
    const lat = new Array<number>(units.length);
    const lon = new Array<number>(units.length);
    for (let i = 0; i < units.length; i++) {
      const { latDeg, lonDeg } = unitLatLon(units[i]!);
      lat[i] = latDeg;
      lon[i] = lonDeg;
    }
    region.nodeLatDeg = lat;
    region.nodeLonDeg = lon;
  }

  /** A requested patch failed. Settling is not optional: an unsettled tile
   * holds an in-flight slot forever and the cascade would deal fewer and
   * fewer requests until it stalled. Settling only frees the slot and counts
   * the attempt; the retry itself comes from `dealRegionRequests`, which
   * re-submits this tile while it is still selected and still patchless, up
   * to CASCADE_MAX_ATTEMPTS — so a persistently-failing region costs a
   * handful of requests, not one per rebuild and not zero. */
  function onRegionError(key: string): void {
    cascade.settle(keyToTile(key), false);
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

  // The Gyre's ocean-current advection overlay: build-once particle seeding,
  // riding the world's spin like winds above, but its particles genuinely
  // drift — `currents.update(day)` steps them every frame (mirroring
  // `ocean.update(day)` below), gated on `currentsOn` so a hidden overlay
  // costs nothing. `null` when there is no current data to show (a locked
  // world zeroes the whole field) — nothing to mount, step, or toggle.
  const currents = createCurrents(tiles, GLOBE_RADIUS);
  if (currents) spinGroup.add(currents.object3d);
  let currentsOn = false;
  function setCurrents(on: boolean): void {
    currentsOn = on;
    currents?.setVisible(on);
  }

  // The Rains' cloud advection overlay: same build-once-seed, per-frame-drift
  // idiom as currents above, but riding the wind (reconstructed from
  // circulationBands) rather than a per-tile current vector. `null` on a
  // locked world (no bands) or a world with no cell above the cloud
  // threshold — nothing to mount, step, or toggle.
  const clouds = createClouds(tiles, GLOBE_RADIUS);
  if (clouds) spinGroup.add(clouds.object3d);
  let cloudsOn = false;
  function setClouds(on: boolean): void {
    cloudsOn = on;
    clouds?.setVisible(on);
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
   * reseats the markers on the moved terrain. The tile rebuild is QUEUED, not
   * done here: `reliefOn` is flipped first, so each tile picks up the new
   * scale as `drainBuildQueue` re-cuts it over the next few frames. The
   * markers move at once — they are a handful of transforms, not 96
   * geometries. */
  function setTrueRelief(on: boolean): void {
    if (on === reliefOn) return;
    reliefOn = on;
    enqueueRebuildAll(); // same tiles, re-cut at the new relief scale, a few per frame
    // Deliberate, disclosed transient: `enqueueRebuildAll` walks
    // `currentSelected`, so a mounted-but-RETIRING tile keeps its OLD relief
    // for the few frames before its disposal lands. It is on its way out —
    // re-cutting it would burn a build slot on geometry about to be thrown
    // away. Not a hole; do not "fix" it.
    // The terrain the markers stand on just moved — reseat them on it.
    for (const marker of markers) placeMarker(marker, reliefScale());
    ocean.setTrueRelief(on);
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

  /** Which geometry a style's tiles are built from — `buildTileSlot` reads
   * `activeStyle` directly, but `setStyle` only needs to know whether the
   * OLD and NEW styles share a geometry family: `faceted` reuses `smooth`'s
   * mesh (material-only difference), while `terraced` and `voxel` each bake
   * their own distinct vertex layout at build time. */
  const geometryFamilyOf = (s: GlobeStyle): 'smooth' | 'terraced' | 'voxel' =>
    s === 'terraced' ? 'terraced' : s === 'voxel' ? 'voxel' : 'smooth';

  // The render-style axis (The Massing): `material` is one object shared
  // across every tile slot (`buildTileSlot`, above), so flipping its
  // `flatShading` flag here repaints every already-built tile without a
  // rebuild — flat shading only recomputes per-face normals from the
  // existing geometry. `terraced` and `voxel` DO change geometry — banding
  // (terraced) or the whole block layout (voxel) is baked into each tile's
  // vertex positions at build time — so entering or leaving either needs a
  // full rebuild, unlike the material-only faceted switch (`buildTileSlot`
  // branches on `activeStyle`, and `activeStyle` is assigned before the
  // enqueue below, so each queued rebuild picks up the right builder whenever
  // it lands). Both also flat-shade: a stepped/blocky surface reads as such
  // only without smooth-shaded normals blurring the risers/cliffs — voxel's
  // own per-cell flat normal attribute (`buildVoxelBlocks`) already agrees
  // with this, so `flatShading` and the geometry's own normals reinforce
  // rather than fight each other.
  function setStyle(style: GlobeStyle): void {
    const prevFamily = geometryFamilyOf(activeStyle);
    activeStyle = style;
    const nextFamily = geometryFamilyOf(activeStyle);
    material.flatShading = activeStyle === 'faceted' || activeStyle === 'terraced' || activeStyle === 'voxel';
    material.needsUpdate = true;
    // As in `setTrueRelief`: `enqueueRebuildAll` iterates `currentSelected`
    // only, so a mounted-but-RETIRING tile keeps its OLD style for the few
    // frames before disposal. Deliberate and disclosed, not a hole.
    if (prevFamily !== nextFamily) enqueueRebuildAll();
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

  // Task 6's "watch a day": pins `seasonalCtx.seasonDayOverride` at the day
  // last painted so the temperature lens' season (and the diurnal pulse's
  // declination) holds still, while `repaint`'s live `day` keeps driving the
  // diurnal pulse's own day fraction — see `SeasonalContext`'s doc comment
  // (`../sim/lockedClimate`) for why one shared `day` argument can freeze
  // only the season half. Mutated in place: `seasonalCtx` is the same object
  // every `colorAt`/`iceFraction` call already closes over.
  function setDayHold(on: boolean): void {
    seasonalCtx.seasonDayOverride = on ? (lastDay ?? 0) : undefined;
  }

  /** Deal the next region requests. Camera-facing tiles go first; the
   * in-flight cap keeps the tail of the queue re-orderable for the next
   * camera move rather than committing it now.
   *
   * The re-submit below is what actually DRIVES the cascade's bounded retry.
   * `settle(t, false)` frees the in-flight slot and counts the attempt, but it
   * cannot re-queue the tile by itself — that needs a later `submit`, and the
   * only other submit sites are construction and `buildTileSlot`. A failed
   * base tile stays mounted under an UNCHANGED key, so nothing rebuilds it and
   * nothing would ever re-ask: the documented retry would fire only if some
   * unrelated event happened to re-cut that tile. Re-offering the
   * still-desired, still-patchless selected tiles every frame closes that
   * hole. It is idempotent and cheap — `submit` drops anything queued,
   * in-flight, or settled — and a tile retired at CASCADE_MAX_ATTEMPTS is in
   * `settled`, so retirement still sticks and this never becomes an infinite
   * retry loop. */
  function dealRegionRequests(camera?: THREE.Camera): void {
    if (requestRegion === undefined) return;
    if (regionsEnabled) cascade.submit(currentSelected.filter((t) => !regionCache.has(tileKey(t))));
    if (camera !== undefined) cascade.reprioritize(cameraUnitFor(camera));
    for (const t of cascade.next()) requestRegion(t);
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
    if (currentsOn) currents?.update(day);
    if (cloudsOn) clouds?.update(day);
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
    if (!camera) {
      drainBuildQueue(); // finish any pending builds even on a camera-less tick
      dealRegionRequests(); // …and deal what they asked for, in submission order
      return;
    }
    reselect(camera); // per-tile CDLOD; reconciles the leaf set (enqueues, retires)
    drainBuildQueue(); // build a few queued tiles this frame (amortized, hole-free)
    dealRegionRequests(camera); // ask for the next few patches, camera-facing first
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
    setCurrents,
    setClouds,
    setWaves,
    setGlint,
    setNightFill,
    setSeasonalHold,
    setDayHold,
    setStyle,
    onRegion,
    onRegionError,
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
