import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import {
  GLOBE_RADIUS,
  MARKER_CLEARANCE,
  RELIEF_EXAGGERATION,
  clusterFeatures,
  createGlobeView,
  diffTileSets,
  gateRefinement,
  onNearSide,
  sampleTile,
  seasonalSpinZ,
  subsolarPoint,
  tileIndexOfVertex,
} from './globe';
import { REFERENCE_RADIUS_M } from './worldMesh';
import { LOD_MIN_LEVEL, TILE_QUADS, children, tileCenterUnit, tileKey, type TileId } from './cubeSphere';
import { CASCADE_MAX_ATTEMPTS, CASCADE_MAX_IN_FLIGHT } from './cascade';
import { iceFraction } from './ice';
import { rotationPhase } from '../sim/ephemeris';
import type { RegionScene, SystemScene, TilesScene } from '../sim/scene';
import { loadSeed42Tiles, loadSeed42System } from '../testHelpers/wasmFixture';
import { moistureLens, naturalLens, temperatureLens } from './lens';

const TAU = Math.PI * 2;

test('diffTileSets: unchanged tiles are kept, neither added nor removed', () => {
  const a: TileId = { face: 0, level: 1, ix: 0, iy: 0 };
  const b: TileId = { face: 0, level: 1, ix: 1, iy: 0 };
  const prevKeys = new Set([tileKey(a), tileKey(b)]);
  const { added, removed, keptCount } = diffTileSets(prevKeys, [a, b]);
  expect(added).toEqual([]);
  expect(removed).toEqual([]);
  expect(keptCount).toBe(2);
});

test('diffTileSets: a mixed before/after — kept, a split (1→4), and a merge (4→1)', () => {
  const kept: TileId = { face: 0, level: 1, ix: 0, iy: 0 };
  // One tile splits into its four children.
  const splitParent: TileId = { face: 1, level: 1, ix: 0, iy: 0 };
  const splitKids = children(splitParent);
  // Four sibling tiles merge back into their shared parent.
  const mergedParent: TileId = { face: 2, level: 1, ix: 0, iy: 0 };
  const mergeKids = children(mergedParent);

  const prev = [kept, splitParent, ...mergeKids];
  const next = [kept, ...splitKids, mergedParent];
  const prevKeys = new Set(prev.map(tileKey));

  const { added, removed, keptCount } = diffTileSets(prevKeys, next);

  expect(keptCount).toBe(1);
  expect(added.length).toBe(4 + 1); // the split's 4 children + the merge's 1 parent
  expect(removed.length).toBe(1 + 4); // the split's 1 parent + the merge's 4 children
  expect(new Set(added.map(tileKey))).toEqual(new Set([...splitKids.map(tileKey), tileKey(mergedParent)]));
  expect(new Set(removed)).toEqual(new Set([tileKey(splitParent), ...mergeKids.map(tileKey)]));
});

test('gateRefinement holds a refining split back at the current coarser tile', () => {
  const coarse: TileId = { face: 0, level: 1, ix: 0, iy: 0 };
  const finer = children(coarse); // the target wants to split into these 4
  expect(gateRefinement([coarse], finer)).toEqual([coarse]);
});

test('gateRefinement lets a coarsening merge through immediately', () => {
  const parentTile: TileId = { face: 0, level: 1, ix: 0, iy: 0 };
  const kids = children(parentTile); // currently shown split
  expect(gateRefinement(kids, [parentTile])).toEqual([parentTile]); // target wants to merge
});

test('gateRefinement passes an unchanged tile through untouched', () => {
  const t: TileId = { face: 3, level: 2, ix: 1, iy: 1 };
  expect(gateRefinement([t], [t])).toEqual([t]);
});

/** A minimal `scene/tiles-region/v1` fixture at `(face, level, ix, iy)`: only
 * the fields `buildRegionTileGeometry` (elevation_m, samples, the tile
 * address) and `moistureLens.colorAt` (moisture) read — the same
 * minimal-fixture convention `worldMesh.test.ts`'s
 * `buildRegionTileGeometry meshes a region patch` test uses. `moisture`
 * (not `natural`'s ocean/biome/ice fields) is deliberate: the ice blend
 * under `natural` reads `tDiurnalAmpC`, a `TilesScene`-only field this
 * region fixture has no reason to carry. */
function regionFixture(face: number, level: number, ix: number, iy: number, samples: number): RegionScene {
  const n = (samples + 1) * (samples + 1);
  return {
    face,
    level,
    ix,
    iy,
    samples,
    elevation_m: Array(n).fill(500),
    moisture: Array(n).fill(0.5),
  } as unknown as RegionScene;
}

/** Every `globe-tile-<key>` mesh currently mounted under `view`, keyed by
 * `tileKey` — the incremental diff's mounted-slot set is otherwise private
 * to `globe.ts`, so a test reads it back the same way `faceColors` does. */
function tileMeshesByKey(view: ReturnType<typeof createGlobeView>): Map<string, THREE.Mesh> {
  const out = new Map<string, THREE.Mesh>();
  view.object3d.traverse((o) => {
    if (o.name.startsWith('globe-tile-')) out.set(o.name.slice('globe-tile-'.length), o as THREE.Mesh);
  });
  return out;
}

/** One FIXED base tile's mesh, by key. The style/relief tests compare a tile's
 * geometry before and after a rebuild, and an amortized rebuild remounts each
 * tile at the end of the scene-graph child list as it lands — so "the first
 * `globe-tile-*` in traverse order" is no longer necessarily the same tile
 * before and after. This key is: it belongs to the base set, which every
 * style/relief test below keeps selected (camera-less, or parked far enough
 * out that nothing subdivides), so it stays mounted throughout. */
const BASE_TILE_KEY = `0:${LOD_MIN_LEVEL}:0:0`;
function baseTileMesh(view: ReturnType<typeof createGlobeView>): THREE.Mesh {
  const mesh = tileMeshesByKey(view).get(BASE_TILE_KEY);
  if (!mesh) throw new Error(`base tile ${BASE_TILE_KEY} is not mounted`);
  return mesh;
}

/** Drive `update` enough frames to fully drain the amortized build queue — LOD
 * refinement now builds only a few tiles per frame, so a single update no longer
 * reaches the fully-built settled set. 48 frames far exceed any one refine.
 * `camera` is optional: omitted, these are camera-less ticks that drain the
 * queue without re-selecting the leaf set — what the style/relief tests want,
 * since a default camera sits at the origin (inside the globe) and would
 * subdivide everything. */
function pump(view: ReturnType<typeof createGlobeView>, camera?: THREE.Camera, n = 48): void {
  for (let i = 0; i < n; i++) view.update(0, camera);
}

/** How many tile geometries `globe.ts` has built so far — its
 * `__slotBuildCount` hook, the same globalThis instrumentation pattern as
 * `__btCount`/`__swapCount`. Monotonic, so tests take a difference. The
 * style/relief tests use it to assert the rebuild is QUEUED rather than done
 * inline: the count must not move across the call itself, then move by at most
 * MAX_BUILDS_PER_FRAME per pumped frame. */
const buildCountHost = globalThis as { __slotBuildCount?: number };
const slotBuilds = (): number => buildCountHost.__slotBuildCount ?? 0;

/** How many whole-globe region stitches `globe.ts` has run — its
 * `__stitchCount` hook, the same monotonic globalThis counter as
 * `__slotBuildCount` above, so a test takes a difference against a baseline. */
const stitchCountHost = globalThis as { __stitchCount?: number; __swapCount?: number };
const stitches = (): number => stitchCountHost.__stitchCount ?? 0;
/** Region swaps performed — `globe.ts`'s `__swapCount`, likewise monotonic. */
const swaps = (): number => stitchCountHost.__swapCount ?? 0;

// Lift the drain's per-frame TIME budget for the whole globe suite so the build
// queue drains at the count cap (MAX_BUILDS_PER_FRAME) on any machine. Without
// this, a slow CI box drains ~1 tile/frame while a fast dev box drains ~6, so a
// fixed `pump` that finishes the (LOD-deep) queue locally leaves it undrained in
// CI — the environment-dependent failure that these `pump`-based tests hit. The
// count cap stays in force, so progressive-drain behaviour is unchanged.
const buildBudgetHost = globalThis as { __buildBudgetMs?: number };
let savedBuildBudget: number | undefined;
beforeAll(() => {
  savedBuildBudget = buildBudgetHost.__buildBudgetMs;
  buildBudgetHost.__buildBudgetMs = Number.POSITIVE_INFINITY;
});
afterAll(() => {
  buildBudgetHost.__buildBudgetMs = savedBuildBudget;
});

test('onRegion swaps only the arriving tile to region geometry — other tiles keep their geometry object; an unmounted key is a no-op', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  // Sidestep the ice blend's TilesScene-only field (see regionFixture's doc).
  view.setLens(moistureLens);

  // Camera just above the surface: whatever tile sits under it is close
  // enough (dist << threshold at every level) to subdivide all the way to
  // LOD_CDLOD_MAX_LEVEL, so a tile deeper than the base level is guaranteed
  // to mount regardless of which face the spin has rotated under the point.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  // On-settle refinement holds refining splits back until the camera has been
  // still for a couple of frames; the amortized build queue then sharpens over
  // subsequent frames — pump enough to reach the settled, fully-built set.
  pump(view, camera);

  const before = tileMeshesByKey(view);
  let targetKey: string | null = null;
  let otherKey: string | null = null;
  for (const key of before.keys()) {
    const level = Number(key.split(':')[1]);
    if (level > LOD_MIN_LEVEL && targetKey === null) targetKey = key;
    else if (key !== targetKey && otherKey === null) otherKey = key;
  }
  expect(targetKey).not.toBeNull(); // the deep zoom actually subdivided past the base level
  expect(otherKey).not.toBeNull(); // and left at least one other tile mounted
  const otherMeshBefore = before.get(otherKey!)!;
  const otherGeomBefore = otherMeshBefore.geometry;
  const targetGeomBefore = before.get(targetKey!)!.geometry;

  // A region arriving for a key nothing currently mounts: cached against a
  // future selection, not applied now — never throws.
  const staleKey = '5:9:9:9'; // level 9 exceeds LOD_CDLOD_MAX_LEVEL — never a real selected tile
  expect(() => view.onRegion(staleKey, regionFixture(5, 9, 9, 9, TILE_QUADS))).not.toThrow();

  const [face, level, ix, iy] = targetKey!.split(':').map(Number) as [number, number, number, number];
  // Matches the real producer contract (`main.ts`'s requestRegion reply):
  // every region arrives sampled at TILE_QUADS — `buildTileSlot`'s region
  // branch reuses the module-level `identityIdx` (sized TILE_QUADS+1
  // squared) for every region tile rather than deriving it from
  // `region.samples`, so a region at any other sample count is outside the
  // contract this path assumes.
  const samples = TILE_QUADS;
  const region = regionFixture(face, level, ix, iy, samples);
  view.onRegion(targetKey!, region);
  pump(view, camera); // pendingUpgrades → the swap is enqueued and drains in over frames

  const after = tileMeshesByKey(view);
  expect(after.has(staleKey)).toBe(false); // (c) still a no-op — no mesh ever built for it

  // (a) the target tile's geometry became the region's: a genuinely new
  // geometry object (the swap actually happened, not a no-op) whose surface
  // vertex count matches the region's (samples+1)^2 node count plus the
  // fixed 4*(samples+1) skirt apron (worldMesh.test.ts pins the same formula
  // for buildRegionTileGeometry).
  const targetGeomAfter = after.get(targetKey!)!.geometry;
  expect(targetGeomAfter).not.toBe(targetGeomBefore);
  const n = samples + 1;
  expect(targetGeomAfter.getAttribute('position').count).toBe(n * n + 4 * n);

  // (b) another mounted tile's mesh AND geometry are the exact same object
  // references as before the swap — applyTileSet never touched it (no
  // rebuild-all).
  expect(after.get(otherKey!)).toBe(otherMeshBefore);
  expect(after.get(otherKey!)!.geometry).toBe(otherGeomBefore);
  // Generous timeout: this test builds the full LOD-deep subdivision queue plus
  // the region swap; count-capped it is fast on a dev box but slower per build
  // on constrained CI hardware. Correctness comes from the count-capped drain
  // (above); this only guards against a slow-box timeout, not a hang.
}, 30_000);

test('caps outstanding region requests at the cascade in-flight limit', () => {
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => {
    requested.push(t);
  });
  view.setLens(moistureLens); // see regionFixture's doc — the fixture has no ice fields
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera);

  // Nothing was delivered, so nothing settles and the cap must hold — however
  // many frames we pump. Before the cascade every deep build fired its own
  // request, so this ran to dozens.
  expect(requested.length).toBeGreaterThan(0); // patches were actually dealt (every level asks for one)
  expect(requested.length).toBeLessThanOrEqual(CASCADE_MAX_IN_FLIGHT);
}, 30_000);

test('requests region patches for the base level, not just deep tiles', () => {
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => {
    requested.push(t);
  });
  view.setLens(moistureLens); // see regionFixture's doc — no ice fields on a patch
  // Far enough out that nothing subdivides past the base level (the settled
  // set is exactly the base set), so every request here is a BASE tile asking
  // for its own patch — the whole point of REGION_MIN_LEVEL 0. Before The
  // Cascade this camera requested nothing at all.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every((t) => t.level === LOD_MIN_LEVEL)).toBe(true);
});

test('a tidally locked world renders its whole base set at level 1, matched to the export it actually has', () => {
  // `regionsEnabled` is false without a rotation period (the locked-temperature
  // lens needs the width/height a RegionScene lacks), so a locked world gets NO
  // patches at any level — it must still mount the full base set from the tiles
  // export. This is the path REGION_MIN_LEVEL 0 could most easily have broken.
  //
  // And it mounts it at level 1 (24 tiles / 512 columns), NOT LOD_MIN_LEVEL.
  // LOD_MIN_LEVEL's 1024-column lattice is sized for a globe whose tiles get
  // replaced by real patches; a locked world never receives one, so that
  // lattice would resample the same 512-column export onto 4× the vertices —
  // interpolation dressed as detail, which decision 0022 forbids.
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), lockedSys(), [], (t) => {
    requested.push(t);
  });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  expect(requested).toEqual([]);
  expect(tileMeshesByKey(view).size).toBe(6 * 4 ** 1);
});

test('a spinning world keeps the finer LOD_MIN_LEVEL base — the lattice patches will fill', () => {
  // The counterpart to the locked case above: patches DO arrive here, so the
  // finer base earns its vertices.
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  expect(tileMeshesByKey(view).size).toBe(6 * 4 ** LOD_MIN_LEVEL);
});

test('a streaming cascade does not pay a whole-globe region stitch per arriving patch', () => {
  // `stitchMountedRegions` reconciles normals across ALL mounted region tiles,
  // so its cost scales with the mounted set, not with what just changed. Firing
  // it on every drain-completion meant re-stitching the whole globe once per
  // handful of arriving patches — 51 whole-globe passes across a boot plus a
  // deep zoom, 90% of all build-queue time, and the terrain-load stutter
  // itself. It is now deferred up to STITCH_MAX_DEFERRAL_FRAMES while the
  // cascade is busy.
  //
  // Deliberately NOT a "wait for the cascade to go idle" gate: a spinning globe
  // sweeps new tiles into the leaf set continuously, so at zoom the cascade
  // need never go quiet, and gating on that would leave the seams permanent.
  const stitchBase = stitches(); // the counters are monotonic across the suite
  const swapBase = swaps();
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => {
    requested.push(t);
  });
  view.setLens(moistureLens); // see regionFixture's doc — the fixture has no ice fields
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);

  // Feed the cascade one frame at a time, delivering everything it asks for as
  // it asks — so a patch lands, swaps in, and re-dirties the region set on
  // essentially every frame. This is the streaming boot, slowed to one frame
  // per step so the deferral window is countable rather than inferred.
  const FRAMES = 90; // 3 × STITCH_MAX_DEFERRAL_FRAMES
  let delivered = 0;
  for (let f = 0; f < FRAMES; f++) {
    view.update(0, camera);
    const batch = requested.slice(delivered);
    delivered = requested.length;
    for (const t of batch) view.onRegion(tileKey(t), regionFixture(t.face, t.level, t.ix, t.iy, TILE_QUADS));
  }

  // Non-vacuous: patches genuinely landed and swapped in over those frames.
  expect(swaps() - swapBase).toBeGreaterThan(20);
  // ...yet the whole-globe pass ran a handful of times, not once per swap. The
  // bound is FRAMES / STITCH_MAX_DEFERRAL_FRAMES, plus one for the undelayed
  // first stitch and one for a frame where the cascade happened to be idle.
  expect(stitches() - stitchBase).toBeLessThanOrEqual(FRAMES / 30 + 2);
  // ...and it did keep running: deferral must not become suppression, or the
  // seams it exists to remove would never be removed at all.
  expect(stitches() - stitchBase).toBeGreaterThan(0);
}, 60_000);

test('resumes requesting once delivered patches settle, and a failed patch frees its slot too', () => {
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => {
    requested.push(t);
  });
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera);
  const firstBatch = [...requested];
  expect(firstBatch.length).toBeGreaterThan(0);

  // Deliver them all: the cascade frees its slots and deals the next batch.
  for (const t of firstBatch) view.onRegion(tileKey(t), regionFixture(t.face, t.level, t.ix, t.iy, TILE_QUADS));
  pump(view, camera);
  const secondBatch = requested.slice(firstBatch.length);
  expect(secondBatch.length).toBeGreaterThan(0);

  // A failure settles too, or the cap would leak a slot permanently.
  for (const t of secondBatch) view.onRegionError(tileKey(t));
  pump(view, camera);
  expect(requested.length).toBeGreaterThan(firstBatch.length + secondBatch.length);
}, 30_000);

test('a failed patch is re-requested on a later frame, and stops after CASCADE_MAX_ATTEMPTS', () => {
  // The bounded retry needs something to DRIVE it. `cascade.settle(t, false)`
  // frees the in-flight slot and counts the attempt, but re-queueing takes a
  // later `submit` — and a failed base tile stays mounted under an unchanged
  // key, so nothing rebuilds it and `buildTileSlot` never re-submits it.
  // `dealRegionRequests` re-offering the still-selected, still-patchless tiles
  // each frame is what makes the documented retry real.
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => {
    requested.push(t);
  });
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40); // whole-globe view: the base set, nothing deeper

  // Fail every patch as it is asked for, and keep pumping.
  let failed = 0;
  for (let f = 0; f < 200; f++) {
    view.update(0, camera);
    for (; failed < requested.length; failed++) view.onRegionError(tileKey(requested[failed]!));
  }

  const perTile = new Map<string, number>();
  for (const t of requested) perTile.set(tileKey(t), (perTile.get(tileKey(t)) ?? 0) + 1);
  expect(perTile.size).toBe(6 * 4 ** LOD_MIN_LEVEL); // every base tile was asked for…
  // …and each was retried, then retired — exactly CASCADE_MAX_ATTEMPTS tries.
  // Without the re-submit this is 1 apiece and the tile stays coarse forever.
  expect([...new Set(perTile.values())]).toEqual([CASCADE_MAX_ATTEMPTS]);

  // Retirement sticks: `submit` drops anything in `settled`, so the re-submit
  // is not an infinite retry loop. More frames ask for nothing further.
  const total = requested.length;
  for (let f = 0; f < 20; f++) view.update(0, camera);
  expect(requested.length).toBe(total);
}, 30_000);

test('refines under autoplay spin: a still camera reaches a deep tile while the world rotates (settle keys off the user camera, not the diurnal spin)', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  view.setLens(moistureLens);

  // Camera parked just above the surface and NEVER moved — but the day
  // advances each frame, so the world spins (spinGroup.rotation.z tracks
  // rotationPhase). The settle gate must key off the user's world-space camera
  // (still), not the camera re-expressed in the spinning frame (which sweeps
  // with the world). The earlier version measured the spun frame, so under any
  // playing clock the gate never released and the globe stayed at
  // LOD_MIN_LEVEL — this asserts refinement survives a live clock.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  // 48 frames, matching `pump`'s default: the base set is 6·4^LOD_MIN_LEVEL
  // tiles and the queue is FIFO, so the base pass alone occupies the first
  // ~16 frames at MAX_BUILDS_PER_FRAME before a deep tile can be reached. The
  // 8 frames this test used when the base was 24 tiles now only measure how
  // long the base takes to mount, not whether refinement happens at all.
  for (let f = 0; f < 48; f++) view.update(f * 0.05, camera); // ~2.4 days of spin

  const maxLevel = Math.max(...[...tileMeshesByKey(view).keys()].map((k) => Number(k.split(':')[1])));
  expect(maxLevel).toBeGreaterThan(LOD_MIN_LEVEL); // refined past the base despite the spin (a buggy gate froze it AT the base)
});

test('LOD refinement is amortized and hole-free: a big refine builds a few tiles per frame while the coarse tiles it replaces stay mounted until their replacements exist', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  const deep = (v: ReturnType<typeof createGlobeView>) =>
    [...tileMeshesByKey(v).keys()].filter((k) => Number(k.split(':')[1]) > LOD_MIN_LEVEL).length;

  // Settle far away (a coarse set), then zoom to the surface — a big refine.
  camera.position.set(GLOBE_RADIUS * 4, 0, 0);
  pump(view, camera);
  const coarseCount = tileMeshesByKey(view).size;
  const coarseMax = Math.max(...[...tileMeshesByKey(view).keys()].map((k) => Number(k.split(':')[1])));

  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  view.update(0, camera);
  view.update(0, camera);
  view.update(0, camera); // 3rd frame: settled → the whole refine is enqueued, first drain caps it

  // Hole-free: nothing was disposed before its replacement built — the coarse
  // cover is all still mounted (retiring), so the total only grew.
  expect(tileMeshesByKey(view).size).toBeGreaterThanOrEqual(coarseCount);
  const partialDeep = deep(view);

  pump(view, camera); // finish draining the refine
  const fullDeep = deep(view);
  expect(fullDeep).toBeGreaterThan(partialDeep); // amortized: frame 1 did NOT build the whole refine
  const settledMax = Math.max(...[...tileMeshesByKey(view).keys()].map((k) => Number(k.split(':')[1])));
  expect(settledMax).toBeGreaterThan(coarseMax); // refined deeper than the coarse start
});

test('mounts the base set through the build queue, not all at once', () => {
  const view = makeGlobe();
  // The initial mount must be amortized like any other refine: a handful of
  // tiles on the first frame, not the whole base set.
  expect(tileMeshesByKey(view).size).toBeLessThanOrEqual(6);

  // A camera far enough out that no tile subdivides past the base level, so
  // the settled set is exactly the base set. (A default PerspectiveCamera
  // sits at the origin — INSIDE the globe — and is never a valid probe.)
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  expect(tileMeshesByKey(view).size).toBe(6 * 4 ** LOD_MIN_LEVEL);
});

test('mounted region patches are normal-stitched: adjacent same-level region tiles share identical edge normals (no shading seam)', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera); // settled + fully built: a deep patch under the camera

  // Find two horizontally-adjacent (same face/level/iy, ix differing by 1)
  // mounted tiles deeper than the base level — they share an exact edge.
  const keys = [...tileMeshesByKey(view).keys()];
  let a: string | null = null;
  let b: string | null = null;
  for (const k of keys) {
    const [f, l, ix, iy] = k.split(':').map(Number) as [number, number, number, number];
    if (l <= LOD_MIN_LEVEL) continue;
    const east = `${f}:${l}:${ix + 1}:${iy}`;
    if (keys.includes(east)) {
      a = k;
      b = east;
      break;
    }
  }
  expect(a).not.toBeNull(); // an adjacent same-level deep pair actually mounted
  expect(b).not.toBeNull();

  // Deliver sloped, boundary-continuous regions for both, then apply. Elevation
  // rises west→east by global column so the shared border stays continuous but
  // the clamped analytic probe would leave a one-sided edge normal without the
  // scoped stitch.
  const sloped = (key: string): RegionScene => {
    const [f, l, ix, iy] = key.split(':').map(Number) as [number, number, number, number];
    const s = TILE_QUADS;
    const elevation_m: number[] = [];
    for (let row = 0; row <= s; row++) for (let col = 0; col <= s; col++) elevation_m.push((ix * s + col) * 400);
    return { face: f, level: l, ix, iy, samples: s, elevation_m, moisture: Array((s + 1) * (s + 1)).fill(0.5) } as unknown as RegionScene;
  };
  view.onRegion(a!, sloped(a!));
  view.onRegion(b!, sloped(b!));
  pump(view, camera); // both swaps drain in → stitchMountedRegions reconciles them

  const meshes = tileMeshesByKey(view);
  const seen = new Map<string, [number, number, number]>();
  let shared = 0;
  let allAgree = true;
  for (const key of [a!, b!]) {
    const g = meshes.get(key)!.geometry;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const kk = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
      const n: [number, number, number] = [nrm.getX(i), nrm.getY(i), nrm.getZ(i)];
      const prev = seen.get(kk);
      if (prev) {
        shared++;
        if (Math.abs(prev[0] - n[0]) > 1e-5 || Math.abs(prev[1] - n[1]) > 1e-5 || Math.abs(prev[2] - n[2]) > 1e-5) allAgree = false;
      } else seen.set(kk, n);
    }
  }
  expect(shared).toBeGreaterThan(0); // the two patches genuinely share edge vertices (non-vacuous)
  expect(allAgree).toBe(true); //       and the scoped stitch made their normals identical
});

test('sampleTile maps lat/lon to the row-major equirect lattice', () => {
  // 4×2 lattice: row 0 is lat +90..0, col 0 is lon -180.
  const tiles = { width: 4, height: 2, elevation_m: [0, 1, 2, 3, 4, 5, 6, 7] } as never;
  expect(sampleTile(tiles, 45, -180, 'elevation_m')).toBe(0);
  expect(sampleTile(tiles, -45, 90, 'elevation_m')).toBe(7);
});

test('sampleTile reads other per-tile layers by the same lattice', () => {
  const tiles = {
    width: 4,
    height: 2,
    ocean: [true, false, false, false, false, false, false, true],
    biome: [0, 1, 2, 3, 4, 5, 6, 7],
  } as never;
  expect(sampleTile(tiles, 45, -180, 'ocean')).toBe(true);
  expect(sampleTile(tiles, -45, 90, 'biome')).toBe(7);
});

test('sampleTile wraps longitude at the +180/-180 seam', () => {
  const tiles = { width: 4, height: 2, elevation_m: [0, 1, 2, 3, 4, 5, 6, 7] } as never;
  // lon 180 wraps to the same column as lon -180 (col 0).
  expect(sampleTile(tiles, 45, 180, 'elevation_m')).toBe(0);
});

test('subsolar latitude swings ±obliquity over the year', () => {
  // Adapted to the parsed (camelCase) SystemScene shape (see system.test.ts's
  // precedent) — the brief's sketch uses raw scene/system/v1 snake_case.
  const sys = {
    world: { obliquityDeg: 20, yearDays: 360, yearPhaseOffset: 0, dayLengthDays: 1 },
  } as never;
  const lats = [0, 90, 180, 270].map((d) => subsolarPoint(sys, d).lat);
  expect(Math.max(...lats)).toBeCloseTo(20, 5);
  expect(Math.min(...lats)).toBeCloseTo(-20, 5);
});

test('subsolar longitude sweeps a full turn per day_length_days for a spinning world', () => {
  const sys: SystemScene = {
    schema: 'scene/system/v1',
    seed: 1,
    star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.9, hzOuterAu: 1.4 },
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 20, yearPhaseOffset: 0 },
    moons: [],
  };
  const a = subsolarPoint(sys, 0).lon;
  const b = subsolarPoint(sys, 1).lon;
  // A full day_length_days later, the sub-solar point has swept exactly one
  // full turn and returns to the same longitude.
  expect(b).toBeCloseTo(a, 8);
  const quarter = subsolarPoint(sys, 0.25).lon;
  expect(quarter).not.toBeCloseTo(a, 3);
});

test('seasonalSpinZ freezes the spin at a fixed reference regardless of day when hold is on', () => {
  const sys = spinningSys();
  // Fractional days: dayLengthDays is 1 here, so integer days would land on
  // the same phase even unfrozen and mask a mutation that ignored `hold`.
  expect(seasonalSpinZ(sys, 10.3, true)).toBe(0);
  expect(seasonalSpinZ(sys, 10.3, true)).toBe(seasonalSpinZ(sys, 200.7, true));
  // Confirms this isn't a coincidence of the chosen days: the unfrozen spin
  // at the same days actually differs from the frozen 0.
  expect(seasonalSpinZ(sys, 10.3, false)).not.toBe(0);
});

test('seasonalSpinZ reproduces today\'s spin when hold is off', () => {
  const sys = spinningSys();
  expect(seasonalSpinZ(sys, 10.3, false)).toBeCloseTo(rotationPhase(sys, 10.3) * TAU, 10);
  // dayLengthDays is 1 here, so integer days share a phase — compare
  // fractional days to actually observe the sweep.
  expect(seasonalSpinZ(sys, 10.3, false)).not.toBeCloseTo(seasonalSpinZ(sys, 200.7, false), 3);
});

test('sub-solar latitude keeps advancing with day independent of the spin freeze', () => {
  const sys = spinningSys();
  // subsolarPoint takes no hold parameter — its latitude term (obliquity ×
  // year phase) is untouched by seasonalSpinZ's freeze either way, which is
  // exactly what lets the season keep moving while the mesh holds still.
  expect(subsolarPoint(sys, 10).lat).not.toBeCloseTo(subsolarPoint(sys, 200).lat, 3);
});

/** Minimal spinning system for createGlobeView. */
function spinningSys(): SystemScene {
  return {
    schema: 'scene/system/v1',
    seed: 1,
    star: { className: 'yellow dwarf (G)', luminosityRel: 1, hzInnerAu: 0.9, hzOuterAu: 1.4 },
    world: { orbitAu: 1, yearDays: 360, dayLengthDays: 1, obliquityDeg: 20, yearPhaseOffset: 0 },
    moons: [],
  };
}

/** `spinningSys()`'s tidally locked twin — no rotation period, so
 * `createGlobeView`'s `regionsEnabled` is false and the globe renders from the
 * tiles export alone at every level. */
function lockedSys(): SystemScene {
  const sys = spinningSys();
  return { ...sys, world: { ...sys.world, dayLengthDays: null } };
}

/** 4×2 all-land world at a uniform 1000 m, with `features`. */
function markerTiles(features: TilesScene['features']): TilesScene {
  const n = 8;
  return {
    schema: 'scene/tiles/v1', width: 4, height: 2, sea_level_m: 0,
    elevation_m: Array(n).fill(1000), ocean: Array(n).fill(false),
    biome: Array(n).fill(0), biomeLegend: ['steppe'], features,
    t_mean_c: Array(n).fill(15), t_swing_c: Array(n).fill(5), tDiurnalAmpC: Array(n).fill(8),
    currentEast: Array(n).fill(0), currentNorth: Array(n).fill(0),
    season_period_days: 365, circulationBands: null, moisture: Array(n).fill(0.5),
    plate: Array(n).fill(0), unrest: Array(n).fill(0), locked: false,
    precipMmYr: Array(n).fill(800), snowFraction: Array(n).fill(0.1),
    precipRegime: Array(n).fill(0), cloudFraction: Array(n).fill(0.4),
    weatherPropensity: Array(n).fill(0.6), cloudType: Array(n).fill(0),
    water: Array(n).fill(3), waterLegend: ['ocean', 'salt-basin', 'river', 'dry-land'],
    drainage: Array(n).fill(0), waterfalls: [],
  };
}

test('clusterFeatures groups exact co-located features, flagship first', () => {
  const sites = clusterFeatures([
    { name: 'Alpha', kind: 'settlement', latitude: 10, longitude: 20 },
    { name: 'Beta', kind: 'settlement', latitude: -5, longitude: 60 },
    { name: 'Gamma', kind: 'settlement', latitude: 10, longitude: 20 },
    { name: 'Home', kind: 'flagship', latitude: 10, longitude: 20 },
  ]);
  expect(sites.length).toBe(2);
  const shared = sites.find((s) => s.latitude === 10)!;
  expect(shared.names).toEqual(['Home', 'Alpha', 'Gamma']);
  expect(shared.hasFlagship).toBe(true);
  expect(sites.find((s) => s.latitude === -5)!.names).toEqual(['Beta']);
});

test('marker dots sit on the displaced terrain, in both relief modes', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 45, longitude: 10 }]);
  const view = createGlobeView(tiles, spinningSys());
  const group = view.object3d.getObjectByName('feature-Alpha')!;
  const dot = group.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  const surface = (scale: number) => GLOBE_RADIUS * (1 + (scale * 1000) / REFERENCE_RADIUS_M);
  const clearance = GLOBE_RADIUS * MARKER_CLEARANCE;
  expect(dot.position.length()).toBeCloseTo(surface(RELIEF_EXAGGERATION) + clearance, 6);
  view.setTrueRelief(true);
  expect(dot.position.length()).toBeCloseTo(surface(1) + clearance, 6);
  view.setTrueRelief(false);
  expect(dot.position.length()).toBeCloseTo(surface(RELIEF_EXAGGERATION) + clearance, 6);
});

test('co-located features build one marker group, named for the flagship', () => {
  const tiles = markerTiles([
    { name: 'Alpha', kind: 'settlement', latitude: 45, longitude: 10 },
    { name: 'Home', kind: 'flagship', latitude: 45, longitude: 10 },
  ]);
  const view = createGlobeView(tiles, spinningSys());
  const groups: THREE.Object3D[] = [];
  view.object3d.traverse((o) => {
    if (o.name.startsWith('feature-')) groups.push(o);
  });
  expect(groups.length).toBe(1);
  expect(groups[0]!.name).toBe('feature-Home');
});

test('setNightFill raises an ambient fill, off by default (honest dark terminator)', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 0 }]);
  const view = createGlobeView(tiles, spinningSys());
  let ambient: THREE.AmbientLight | null = null;
  view.object3d.traverse((o) => {
    if ((o as THREE.AmbientLight).isAmbientLight) ambient = o as THREE.AmbientLight;
  });
  const amb = ambient as THREE.AmbientLight | null;
  expect(amb).not.toBeNull();
  expect(amb!.intensity).toBe(0); // default: night side falls to dark
  view.setNightFill(true);
  expect(amb!.intensity).toBeGreaterThan(0);
  view.setNightFill(false);
  expect(amb!.intensity).toBe(0);
});

test('onNearSide admits markers up to the limb and rejects the far side', () => {
  const cam = new THREE.Vector3(0, 0, 6); // r/d = 1/3 → horizon ≈ 70.5°
  const at = (thetaDeg: number) => {
    const t = (thetaDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(t), 0, Math.cos(t));
  };
  expect(onNearSide(at(0), cam, 2)).toBe(true);
  expect(onNearSide(at(60), cam, 2)).toBe(true);
  expect(onNearSide(at(90), cam, 2)).toBe(false); // past the ≈70.5° horizon
  expect(onNearSide(at(180), cam, 2)).toBe(false);
});

test('labels stay hidden until their site is selected', () => {
  const tiles = markerTiles([
    { name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 10 },
    { name: 'Beta', kind: 'settlement', latitude: 5, longitude: 40 },
  ]);
  const view = createGlobeView(tiles, spinningSys());
  const labelOf = (name: string) =>
    view.object3d.getObjectByName(`feature-${name}`)!.children.find((c) => (c as THREE.Sprite).isSprite)! as THREE.Sprite;
  const dotOf = (name: string) =>
    view.object3d.getObjectByName(`feature-${name}`)!.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  view.object3d.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 100);
  camera.position.copy(dotOf('Alpha').getWorldPosition(new THREE.Vector3()).normalize().multiplyScalar(6));
  camera.lookAt(0, 0, 0);
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(false);
  expect(labelOf('Beta').visible).toBe(false);
  view.setSelected('Alpha');
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(true);
  expect(labelOf('Beta').visible).toBe(false);
  view.setSelected(null);
  view.update(0, camera);
  expect(labelOf('Alpha').visible).toBe(false);
});

test('update(day, camera) hides far-side markers and shows near ones', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 0, longitude: 45 }]);
  const view = createGlobeView(tiles, spinningSys());
  const group = view.object3d.getObjectByName('feature-Alpha')!;
  const dot = group.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  view.object3d.updateMatrixWorld(true);
  const facing = dot.getWorldPosition(new THREE.Vector3()).normalize().multiplyScalar(6);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(facing);
  view.update(0, camera);
  expect(dot.visible).toBe(true);
  camera.position.copy(facing).negate();
  view.update(0, camera);
  expect(dot.visible).toBe(false);
});

test('setSeasonalHold(true) freezes globe-spin rotation across days', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  view.setSeasonalHold(true);
  // Fractional days: dayLengthDays is 1 here, so integer days would land on
  // the same phase even unfrozen and mask a mutation that ignored the hold.
  view.update(10.3);
  const spin = view.object3d.getObjectByName('globe-spin')!;
  const rotAt10 = spin.rotation.z;
  view.update(200.7);
  const rotAt200 = spin.rotation.z;
  expect(rotAt10).toBe(0);
  expect(rotAt10).toBe(rotAt200);
});

test('setSeasonalHold(false) (the default) leaves the spin advancing with day, as today', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  // dayLengthDays is 1 for spinningSys(), so integer days all land on the
  // same phase — use fractional days so the sweep is actually observed.
  view.update(10.3);
  const spin = view.object3d.getObjectByName('globe-spin')!;
  const rotAt10 = spin.rotation.z;
  view.update(200.7);
  const rotAt200 = spin.rotation.z;
  expect(rotAt10).not.toBeCloseTo(rotAt200, 3);
});

test('setDayHold(true) pins the temperature lens season while the day advances', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  view.setLens(temperatureLens);
  view.update(10.5); // paint day 10.5 — this is the day setDayHold will pin
  view.setDayHold(true);
  const held1 = faceColors(view);
  // Same day_fraction (.5), far apart integer days: with the season pinned
  // at 10.5, the diurnal pulse's declination and the seasonal baseline are
  // identical to the first paint, so the color must match exactly.
  view.update(200.5);
  const held2 = faceColors(view);
  expect(held2).toEqual(held1);

  view.setDayHold(false);
  view.update(10.5); // day 10.5 again differs from held2's lastDay (200.5) — repaints normally
  const free1 = faceColors(view);
  view.update(200.5);
  const free2 = faceColors(view);
  expect(free2).not.toEqual(free1); // season now free to advance again
});

test('subsolar longitude is frozen for a tidally locked world', () => {
  const sys = lockedSys();
  expect(subsolarPoint(sys, 0).lon).toBe(0);
  expect(subsolarPoint(sys, 123).lon).toBe(0);
});

/** The first globe surface tile's color attribute, copied (the buffer is
 * mutated in place). LOD renders the surface as `globe-tile-*` meshes. */
function faceColors(globe: ReturnType<typeof createGlobeView>): Float32Array {
  let mesh: THREE.Mesh | null = null;
  globe.object3d.traverse((o) => {
    if (!mesh && o.name.startsWith('globe-tile-')) mesh = o as THREE.Mesh;
  });
  return Float32Array.from(
    (mesh as unknown as THREE.Mesh).geometry.getAttribute('color').array as ArrayLike<number>,
  );
}

// `loadSeed42Tiles`/`loadSeed42System` memoize per-argument (wasmFixture.ts),
// so every call below already shared one wasm instantiation each within this
// file; `beforeAll` gives that one real cost (seconds, not vitest's 5s
// default) a single predictable home in a hook with its own timeout, instead
// of paying it inline in whichever test happens to run first. Every test
// below now just reads the file-scoped fixtures, so none needs an elevated
// per-test timeout.
// This file needs two sequential loads (tiles + system), each independently
// observed in the 15-30s range under full-suite contention — a 30s hook
// timeout was measured to be too tight (it fired once), so this one gets
// double the headroom of the single-load files below.
let seed42Tiles: TilesScene;
let seed42System: SystemScene;
beforeAll(async () => {
  seed42Tiles = await loadSeed42Tiles(64);
  seed42System = await loadSeed42System();
}, 60000);

/** A production-shaped globe: a spinning world WITH a region bridge, so
 * `regionsEnabled` is true and the base set is the finer `LOD_MIN_LEVEL` one
 * (`baseLevel` follows `regionsEnabled` — a globe that can never receive a
 * patch drops to level 1 rather than interpolate the export onto 4× the
 * vertices). The callback is a no-op: these tests never deliver a patch, so
 * every tile stays base-data terrain, exactly as before. */
function makeGlobe() {
  return createGlobeView(seed42Tiles, seed42System, [], () => {});
}

test('repaints when the lens changes', () => {
  const globe = makeGlobe();
  globe.update(0);
  const before = faceColors(globe);
  globe.setLens(temperatureLens);
  expect(faceColors(globe)).not.toEqual(before);
});

test('advances the living lens with the clock', () => {
  const globe = makeGlobe();
  globe.setLens(temperatureLens);
  globe.update(0);
  const winter = faceColors(globe);
  globe.update(180); // roughly half a year on
  expect(faceColors(globe)).not.toEqual(winter);
});

test('leaves a static lens alone as the clock runs', () => {
  const globe = makeGlobe();
  globe.setLens(moistureLens);
  globe.update(0);
  const day0 = faceColors(globe);
  globe.update(180);
  expect(faceColors(globe)).toEqual(day0);
});

test('blends ice under natural and never under a data lens', () => {
  const tiles = seed42Tiles;
  const globe = createGlobeView(tiles, seed42System);

  // Under a data lens every vertex is exactly its lens color — no ice blend.
  globe.setLens(moistureLens);
  globe.update(0);
  const data = faceColors(globe);
  const idx = /* the same tile index the recolor used */ 0;
  const expected = moistureLens.colorAt(tiles, tileIndexOfVertex(tiles, 0, idx), 0);
  expect(data[0]).toBeCloseTo(expected[0] / 255, 5);

  // Under natural, an icy vertex's painted color must differ from
  // naturalLens's own raw color at that tile — that difference IS the ice
  // blend. Find a genuinely icy vertex on face 0 (seed 42 has polar ice)
  // rather than assuming vertex 0 is one, so the assertion is pinned to the
  // blend itself and not incidentally satisfied by two lenses just painting
  // different data.
  globe.setLens(naturalLens);
  globe.update(0);
  const natural = faceColors(globe);
  const gridN = (TILE_QUADS + 1) * (TILE_QUADS + 1);
  let icyVertex = -1;
  for (let v = 0; v < gridN; v++) {
    if (iceFraction(tiles, tileIndexOfVertex(tiles, 0, v), 0) > 0) {
      icyVertex = v;
      break;
    }
  }
  expect(icyVertex).toBeGreaterThanOrEqual(0);
  const rawColor = naturalLens.colorAt(tiles, tileIndexOfVertex(tiles, 0, icyVertex), 0);
  expect(natural[3 * icyVertex]).not.toBeCloseTo(rawColor[0] / 255, 5);
});

test('the globe carries an ocean layer that follows the relief toggle', () => {
  // markerTiles is all land — give the west half sea so the ocean mounts.
  const tiles = markerTiles([]);
  tiles.sea_level_m = -2500;
  tiles.elevation_m = [-2600, -2600, -2000, -2000, -2600, -2600, -2000, -2000];
  tiles.ocean = [true, true, false, false, true, true, false, false];
  const view = createGlobeView(tiles, spinningSys());
  const ocean = view.object3d.getObjectByName('ocean')!;
  expect(ocean).toBeDefined();
  const mesh = ocean.children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  const radiusOf = () => {
    const p = mesh.geometry.getAttribute('position');
    return Math.hypot(p.getX(0), p.getY(0), p.getZ(0));
  };
  const before = radiusOf();
  view.setTrueRelief(true);
  expect(radiusOf()).not.toBeCloseTo(before, 6);
  view.setTrueRelief(false);
  expect(radiusOf()).toBeCloseTo(before, 6);
});

test('water is visible under natural only — hidden under every data lens', () => {
  const tiles = markerTiles([]);
  tiles.sea_level_m = -2500;
  tiles.elevation_m = [-2600, -2600, -2000, -2000, -2600, -2600, -2000, -2000];
  tiles.ocean = [true, true, false, false, true, true, false, false];
  const view = createGlobeView(tiles, spinningSys());
  const ocean = view.object3d.getObjectByName('ocean')!;
  // The globe starts on `natural` — water visible from the first frame.
  expect(ocean.visible).toBe(true);
  view.setLens(moistureLens);
  expect(ocean.visible).toBe(false);
  view.setLens(naturalLens);
  expect(ocean.visible).toBe(true);
});

/** The shared surface material off the first mounted `globe-tile-*` mesh —
 * `material` is one object reused across every tile slot (`globe.ts`'s
 * `buildTileSlot`), so any one tile's material is the whole surface's. */
function surfaceMaterial(globe: ReturnType<typeof createGlobeView>): THREE.MeshStandardMaterial {
  let mesh: THREE.Mesh | null = null;
  globe.object3d.traverse((o) => {
    if (!mesh && o.name.startsWith('globe-tile-')) mesh = o as THREE.Mesh;
  });
  return (mesh as unknown as THREE.Mesh).material as THREE.MeshStandardMaterial;
}

test('setStyle("faceted") flat-shades the surface material; "smooth" restores smooth shading', () => {
  const view = createGlobeView(markerTiles([]), spinningSys());
  const mat = surfaceMaterial(view);
  expect(mat.flatShading).toBe(false);
  // `Material.needsUpdate` (three.js) is a write-only accessor — it has no
  // getter, so reading it back is always `undefined` regardless of what was
  // set. Spy on the setter itself to confirm `setStyle` actually flips it.
  const needsUpdateSpy = vi.spyOn(mat, 'needsUpdate', 'set');
  view.setStyle('faceted');
  expect(mat.flatShading).toBe(true);
  expect(needsUpdateSpy).toHaveBeenCalledWith(true);
  view.setStyle('smooth');
  expect(mat.flatShading).toBe(false);
});

test('setStyle("voxel") rebuilds tile geometry as extruded blocks with cliff walls; "smooth" restores the shared-vertex mesh', () => {
  const globe = makeGlobe(); // real seed-42 terrain — enough relief to produce at least one voxel wall
  const mat = surfaceMaterial(globe);
  expect(mat.flatShading).toBe(false);

  const beforeGeom = baseTileMesh(globe).geometry;
  const beforeCount = beforeGeom.getAttribute('position').count;
  expect(beforeGeom.getIndex()).not.toBeNull(); // the smooth path is a shared-vertex, indexed mesh

  expect(() => globe.setStyle('voxel')).not.toThrow();
  expect(mat.flatShading).toBe(true);
  // The geometry rebuild is amortized (`enqueueRebuildAll`), so the new tiles
  // arrive over the following frames rather than before `setStyle` returns.
  pump(globe);
  const afterGeom = baseTileMesh(globe).geometry;
  expect(afterGeom).not.toBe(beforeGeom); // a genuine rebuild, not a material-only flip
  // Voxel geometry is non-indexed (flat shading needs unshared per-triangle
  // vertices) — structurally distinct from the smooth builder's indexed mesh.
  expect(afterGeom.getIndex()).toBeNull();
  const afterCount = afterGeom.getAttribute('position').count;
  expect(afterCount).not.toBe(beforeCount);
  // VOXEL_CELLS_PER_EDGE (globe.ts, not exported) is 48 — mirrored here so
  // this test doesn't silently stop checking for walls if that constant
  // changes. A walls-free voxel build would have exactly N²×6 vertices (top
  // faces only); real terrain's relief variation across a mounted tile
  // guarantees at least one neighbor pair crosses a band, so the true count
  // must exceed that floor.
  const N = 48;
  expect(afterCount).toBeGreaterThan(N * N * 6);

  expect(() => globe.setStyle('smooth')).not.toThrow();
  expect(mat.flatShading).toBe(false);
  pump(globe);
  const smoothGeom = baseTileMesh(globe).geometry;
  expect(smoothGeom).not.toBe(afterGeom);
  expect(smoothGeom.getIndex()).not.toBeNull(); // back to the shared-vertex indexed mesh
  expect(smoothGeom.getAttribute('position').count).toBe(beforeCount);
});

test('setStyle queues its rebuild instead of re-cutting every mounted tile inline', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  // Far enough out that the settled leaf set is exactly the base set, so the
  // rebuild below is over all 6·4^LOD_MIN_LEVEL tiles — the size that made the
  // synchronous version freeze for seconds.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  const baseSetSize = 6 * 4 ** LOD_MIN_LEVEL;
  expect(tileMeshesByKey(view).size).toBe(baseSetSize);

  // The synchronous part of a style switch must not scale with the base set:
  // it enqueues, it builds nothing.
  const beforeCall = slotBuilds();
  view.setStyle('voxel');
  expect(slotBuilds()).toBe(beforeCall);

  // …and each frame after it builds at most MAX_BUILDS_PER_FRAME (globe.ts,
  // not exported — mirrored here). The suite's `__buildBudgetMs = Infinity`
  // makes the count cap, not wall clock, the governor.
  const MAX_BUILDS_PER_FRAME = 6;
  const beforeFrame = slotBuilds();
  view.update(0, camera);
  expect(slotBuilds() - beforeFrame).toBeLessThanOrEqual(MAX_BUILDS_PER_FRAME);

  // Pumping completes the switch: the whole base set is mounted, and every
  // tile is voxel geometry (non-indexed) — no tile left behind on the old
  // builder, and no hole opened while the queue drained.
  pump(view, camera);
  const after = tileMeshesByKey(view);
  expect(after.size).toBe(baseSetSize);
  for (const mesh of after.values()) expect(mesh.geometry.getIndex()).toBeNull();
});

test('__buildPending reports the queue depth synchronously — the readiness signal e2e polls instead of sleeping', () => {
  const view = createGlobeView(markerTiles([]), spinningSys(), [], () => {});
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);
  const pending = (): number | undefined => (globalThis as { __buildPending?: number }).__buildPending;
  expect(pending()).toBe(0); // settled: every desired tile is mounted

  // The signal must be correct at the instant `setStyle` returns, not only
  // from the next frame — an out-of-process driver polls right after the
  // switch, and a stale 0 there is exactly the race a fixed sleep hides.
  view.setStyle('voxel');
  expect(pending()).toBe(6 * 4 ** LOD_MIN_LEVEL);

  // One frame drains at most MAX_BUILDS_PER_FRAME, so the signal is still
  // non-zero — "the rebuild has landed" is a frame count, not a duration.
  view.update(0, camera);
  expect(pending()).toBeGreaterThan(0);

  pump(view, camera);
  expect(pending()).toBe(0);
});

test('the build queue drains camera-facing tiles first, so the visible hemisphere mounts before the far side', () => {
  // The base set is 96 tiles drained at MAX_BUILDS_PER_FRAME, so a boot mount
  // spans ~16 frames — and on a slow box, where the drain's wall-clock budget
  // affords one build per frame, ~96 of them. WHICH tiles those frames spend
  // themselves on is therefore the whole user-visible question: in queue order
  // the globe fills face-by-face and the surface under the camera can be the
  // last thing to arrive (nothing to look at, and nothing for the inspector's
  // raycast to hit). Camera-facing-first is the same ordering `cascade.ts`
  // already applies to region REQUESTS, now applied to the builds themselves.
  const sys = spinningSys();
  const view = createGlobeView(markerTiles([]), sys, [], () => {});
  // Equatorial and far enough out that the settled leaf set is exactly the
  // base set — so this is purely about order, not about which tiles are wanted.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 40, 0, 0);

  // Tiles live under `spinGroup`, so facing must be judged in the globe's
  // LOCAL frame — the same transform `reselect` does. A world-frame version of
  // this test would pass at spin 0 and drift wrong at every other day.
  const localCam = camera.position
    .clone()
    .applyAxisAngle(new THREE.Vector3(0, 0, 1), -seasonalSpinZ(sys, 0, false))
    .normalize();
  const facing = (key: string): number => {
    const [face, level, ix, iy] = key.split(':').map(Number) as [number, number, number, number];
    const c = tileCenterUnit({ face, level, ix, iy });
    return c[0] * localCam.x + c[1] * localCam.y + c[2] * localCam.z;
  };

  // Four camera-ful frames — a fraction of the 96-tile base set, which is the
  // window this is about. (Construction's own `update(0)` has no camera to
  // order by and drains one batch blind; that batch is the allowance below.)
  const MAX_BUILDS_PER_FRAME = 6;
  for (let i = 0; i < 4; i++) view.update(0, camera);

  const mounted = [...tileMeshesByKey(view).keys()];
  expect(mounted.length).toBeGreaterThan(MAX_BUILDS_PER_FRAME); // the camera-ful frames did build
  expect(mounted.length).toBeLessThan(6 * 4 ** LOD_MIN_LEVEL); // …and did NOT finish the set

  // Every tile mounted since the camera was known faces it. Only construction's
  // blind first batch may sit on the far side, so that is the exact allowance.
  const farSide = mounted.filter((k) => facing(k) <= 0);
  expect(farSide.length).toBeLessThanOrEqual(MAX_BUILDS_PER_FRAME);

  // And the tile the user is looking straight at is up — not queued behind the
  // other five faces. This is the property the inspector's raycast depends on.
  const nearest = mounted.reduce((a, b) => (facing(a) >= facing(b) ? a : b));
  expect(facing(nearest)).toBeGreaterThan(0.9);
});

test('setTrueRelief queues its rebuild too, and reseats the markers at once', () => {
  const tiles = markerTiles([{ name: 'Alpha', kind: 'settlement', latitude: 45, longitude: 10 }]);
  const view = createGlobeView(tiles, spinningSys(), [], () => {});
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera);

  const dot = view.object3d
    .getObjectByName('feature-Alpha')!
    .children.find((c) => (c as THREE.Mesh).isMesh)! as THREE.Mesh;
  const markerBefore = dot.position.length();
  const geomBefore = baseTileMesh(view).geometry;

  const beforeCall = slotBuilds();
  view.setTrueRelief(true);
  expect(slotBuilds()).toBe(beforeCall); // queued, not re-cut inline
  expect(dot.position.length()).not.toBeCloseTo(markerBefore, 6); // markers move immediately

  pump(view, camera);
  expect(baseTileMesh(view).geometry).not.toBe(geomBefore); // …and the terrain follows over frames
  expect(tileMeshesByKey(view).size).toBe(6 * 4 ** LOD_MIN_LEVEL);
});

test("living-lens repaint recolors voxel geometry (tops AND darkened walls) for a new day, without a full rebuild", () => {
  const globe = makeGlobe();
  globe.setStyle('voxel');
  globe.setLens(temperatureLens); // a living (dependsOnDay) lens — every update recomputes color
  pump(globe); // the voxel rebuild is queued — drain it before reading geometry

  const geom = baseTileMesh(globe).geometry;
  const col = geom.getAttribute('color');
  const N = 48; // VOXEL_CELLS_PER_EDGE, mirrored — see the setStyle test above
  const topVerts = N * N * 6;
  expect(col.count).toBeGreaterThan(topVerts); // real terrain: at least one wall to check below

  const before = Array.from({ length: col.count }, (_, v) => [col.getX(v), col.getY(v), col.getZ(v)] as const);

  // A day far enough out that the temperature lens' diurnal+seasonal terms
  // have moved; `update` repaints in place (no camera → no LOD reselect, so
  // the SAME geometry object is repainted, not rebuilt).
  expect(() => globe.update(200)).not.toThrow();
  expect(baseTileMesh(globe).geometry).toBe(geom); // repainted in place, not rebuilt

  const after = Array.from({ length: col.count }, (_, v) => [col.getX(v), col.getY(v), col.getZ(v)] as const);
  expect(after).not.toEqual(before); // the living lens actually repainted something

  // The wall-darkening relationship survives the repaint: averaged over all
  // wall vertices vs all top vertices, the walls must still read darker —
  // confirming `paintSlot`'s per-vertex `darken` multiplier is applied on
  // every repaint, not just at the original build.
  const avgLuminance = (lo: number, hi: number): number => {
    let sum = 0;
    for (let v = lo; v < hi; v++) sum += col.getX(v) + col.getY(v) + col.getZ(v);
    return sum / (hi - lo);
  };
  expect(avgLuminance(topVerts, col.count)).toBeLessThan(avgLuminance(0, topVerts));
});

test('onRegion + setStyle("voxel"): a mounted voxel tile upgrades to the region variant when a patch is cached', () => {
  const tiles = markerTiles([]);
  tiles.moisture = tiles.moisture.map(() => 0.1); // uniform BASE moisture
  const view = createGlobeView(tiles, spinningSys(), [], () => {});
  view.setLens(moistureLens); // sidesteps the ice blend's TilesScene-only field, per regionFixture's doc
  view.setStyle('voxel');

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera);

  const before = tileMeshesByKey(view);
  let targetKey: string | null = null;
  for (const key of before.keys()) {
    if (Number(key.split(':')[1]) > LOD_MIN_LEVEL) {
      targetKey = key;
      break;
    }
  }
  expect(targetKey).not.toBeNull(); // deep zoom subdivided past the base level under voxel too
  const beforeGeom = before.get(targetKey!)!.geometry;
  const beforeColor = beforeGeom.getAttribute('color');
  const beforeSample: [number, number, number] = [beforeColor.getX(0), beforeColor.getY(0), beforeColor.getZ(0)];

  const [face, level, ix, iy] = targetKey!.split(':').map(Number) as [number, number, number, number];
  const samples = TILE_QUADS; // the real producer contract, per the base onRegion test above
  const region = regionFixture(face, level, ix, iy, samples);
  region.moisture = Array((samples + 1) * (samples + 1)).fill(0.9); // distinctly different from the base's 0.1
  view.onRegion(targetKey!, region);
  pump(view, camera); // the swap enqueues and drains in over frames

  const after = tileMeshesByKey(view);
  const afterGeom = after.get(targetKey!)!.geometry;
  expect(afterGeom).not.toBe(beforeGeom); // the region-voxel swap actually rebuilt this slot
  expect(afterGeom.getIndex()).toBeNull(); // still voxel geometry (non-indexed), not a smooth fallback
  const afterColor = afterGeom.getAttribute('color');
  const afterSample: [number, number, number] = [afterColor.getX(0), afterColor.getY(0), afterColor.getZ(0)];
  // Recolored from the REGION's own (different) moisture, not the base
  // tiles' 0.1 — confirms `buildTileSlot`'s voxel branch took the region
  // path (`buildVoxelRegionTileGeometryIndexed`), not the base one.
  expect(afterSample).not.toEqual(beforeSample);
});

test('setStyle("terraced") flat-shades AND rebuilds tile geometry with banded elevation', () => {
  const globe = makeGlobe(); // real seed-42 terrain — enough relief to distinguish banded from continuous
  const mat = surfaceMaterial(globe);
  expect(mat.flatShading).toBe(false);

  const beforeGeom = baseTileMesh(globe).geometry;

  globe.setStyle('terraced');
  expect(mat.flatShading).toBe(true);
  // Unlike faceted (a material-only flag flip), banding changes vertex
  // positions — this must be an actual geometry rebuild, not the same
  // object reused. Queued, so drain it first (`enqueueRebuildAll`).
  pump(globe);
  const afterGeom = baseTileMesh(globe).geometry;
  expect(afterGeom).not.toBe(beforeGeom);

  // Real terrain has enough relief variation that a continuous (Smooth)
  // build shows a distinct radius at nearly every vertex; terraced collapses
  // them onto a small, finite set of band floors — the geometry-level half
  // of `worldMesh.test.ts`'s `quantizeBands` coverage, confirming globe.ts
  // actually wires `bandM` through for a real mounted tile.
  const pos = afterGeom.getAttribute('position');
  const radii = new Set<number>();
  for (let i = 0; i < pos.count; i++) {
    radii.add(Number(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)).toFixed(5)));
  }
  expect(radii.size).toBeGreaterThan(0);
  expect(radii.size).toBeLessThan(pos.count / 4); // far fewer bands than vertices

  globe.setStyle('smooth');
  expect(mat.flatShading).toBe(false);

  // Symmetric with the forward (smooth->terraced) collapse assertion above:
  // switching back must actually rebuild the geometry away from the banded
  // set, not merely flip flatShading back. Real terrain has enough relief
  // variation that a continuous build shows a distinct radius at nearly
  // every vertex, so the reverse rebuild should recover (most of) that
  // many-valued distribution rather than staying stuck on the small banded set.
  pump(globe);
  const smoothGeom = baseTileMesh(globe).geometry;
  const smoothPos = smoothGeom.getAttribute('position');
  const smoothRadii = new Set<number>();
  for (let i = 0; i < smoothPos.count; i++) {
    smoothRadii.add(Number(Math.hypot(smoothPos.getX(i), smoothPos.getY(i), smoothPos.getZ(i)).toFixed(5)));
  }
  expect(smoothRadii.size).toBeGreaterThan(smoothPos.count / 2); // back to (near-)continuous, not banded
});
