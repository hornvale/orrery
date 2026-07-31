# The Cascade — Design

**Date:** 2026-07-30
**Status:** Draft — not started
**Parent contracts:** hornvale `windows/scene/src/region.rs` (`tiles_region_scene_in`, `RegionAddr`) and `clients/world-wasm/src/lib.rs` (`hw_scene_tiles_region`, `SCENE_CTX`), both at hornvale release `world-wasm-v13`. The Massing (CDLOD `selectTiles`, skirts, `LOD_CDLOD_MAX_LEVEL = 6`) and The Region (`scene/tiles-region/v1`, `regionPatch.ts`) are the direct ancestors — this campaign generalizes the region path from a near-camera treatment to the globe's own base.
**Upstream work required:** none to start. Sections 5 and 8.2 name producer-side gaps that bound how far this can go, but the cascade as specced here runs entirely against v13 as shipped.

## 1. Problem

Nathan: *"when we're looking at the globe … everything looks too blurry."*

The default whole-globe view is data-capped, not mesh-capped. `main.ts:156`
requests the base tiles document at `tilesWidth: 512` — a 512×256 equirect
grid — and `LOD_MIN_LEVEL = 1` meshes it at 2 tiles × `TILE_QUADS` (64) per
cube-face edge = 128 samples, which across the four equatorial faces is
exactly 512 columns. The mesh is already matched to the data. Every vertex
colour is a nearest-cell lookup into that same 512-grid, so no LOD change
touches the default view's sharpness. On an Earth-sized world that grid is
roughly 78 km per sample.

Raising `tilesWidth` is the only lever the current architecture has, and it
is a short one. The producer rejects anything above 1024
(`--width 2048 is outside 16..=1024`), and the monolithic shape does not
survive being pushed further even hypothetically: a 4096-wide export is 8.4M
nodes, which at even a fantasy 1 µs/node marginal would be 8.4 s and roughly
a gigabyte of JSON. Widening the export cannot reach the quality being asked
for.

The region path can, because it only pays for what is on screen — but until
this week it was priced out of that role. Pre-`world-wasm-v13`, every
terrain-facing wasm call re-derived the entire planet (~1.05 s floor,
independent of how many nodes it produced: a four-node patch cost the same as
a small export). A 96-tile base globe was ~161 s of producer time.

## 2. Goal

The globe acquires its surface by a **coarse-to-fine cascade of region
patches** rather than from one fixed-resolution equirect export: six level-0
face patches for an immediate complete globe, refining through level 1 to a
level-2 base (96 tiles), with the existing CDLOD descent carrying on deeper
under the camera exactly as it does today.

Two consequences fall out. The base globe reaches 1024-equivalent detail
without asking the producer for a 1024-wide export, so the `width ≤ 1024` cap
stops being the ceiling on globe quality. And refinement becomes **visible and
ordered** — the globe arrives coarse and sharpens, the way every tile-pyramid
map client behaves — instead of arriving blurry and staying blurry until the
user happens to zoom.

## 3. What v13 actually gives us

Measured against the published `world-wasm-v13` asset (sha `29a61ac5…`), seed
42, node 24, one process per binary. Absolute times vary ±30% with machine
load; the ratios are the durable part.

```
  CALL                        v12 (pre-Cistern)   v13 (published)
  -------------------------   -----------------   ---------------
  hw_new(42)                          1391 ms          2833 ms
  region samples=64, first            1687 ms          1212 ms   (builds SceneContext)
  region samples=64, warm             1676 ms            82 ms
  region samples=128, warm            3206 ms           318 ms
  region samples=256, warm            7089 ms          1222 ms
  hw_scene_tiles(512)                 5055 ms          1397 ms
```

The warm region patch is the number this campaign is built on: **82 ms**. A
96-tile level-2 base globe is ~7.9 s of producer time serial, against ~161 s
on v12.

Two caps remain and both are producer-side: `width ≤ 1024` and
`samples ≤ 256`. Neither binds the design below.

`hw_new` roughly doubled between v12 and v13. Nathan has confirmed this as
intentional (worldgen work landed in the same window). It is nonetheless now
the largest single term in cold start — it went from ~22% of boot under v12
to ~55% under v13 — and it is paid per wasm instance, which is what makes a
worker pool less attractive than it first looks (§8.3).

## 4. The cascade

### 4.1 Levels and budget

```
  STEP  LEVEL  TILES  SAMPLES  PRODUCER TIME   RESULT
  ----  -----  -----  -------  -------------   ---------------------------------
   0      -      -       -      ~2.8 s         hw_new (unavoidable, unchanged)
   1      -      -       -      ~1.4 s         hw_scene_tiles at width 256 (§5);
                                               ~1.0 s of this is SceneContext::build,
                                               paid once here so step 2 runs warm
   2      0      6       64     ~0.5 s         complete globe, 64/face-edge
   3      1     24       64     ~2.0 s         128/face-edge = today's detail
   4      2     96       64     ~7.9 s         256/face-edge = 2x today
   5     3+   on demand  64     82 ms each     CDLOD under the camera (unchanged)
```

First paint moves to the end of step 2 — **~4.7 s, against ~5.2 s today**
(`hw_new` 2.8 s + a cold `hw_scene_tiles(512)` 2.4 s). Steps 3 and 4 refine a
globe the user is already looking at, reaching today's detail at ~6.7 s and
2× it at ~14.6 s.

So the cascade is not a wall-clock win to *full* detail; it is a win to
*first* detail, and it raises the ceiling on what full detail means. If cold
start is the thing being optimized, the lever is `hw_new` (§3), not this.

Note that step 2 is *coarser* than today's first paint (64 vs 128 samples per
face edge). That is deliberate and is the whole bet: a complete coarse globe
at ~4.7 s beats a complete medium globe at ~5.7 s, provided the refinement
that follows is visible and orderly rather than ragged.

### 4.2 Ordering

Within a step, request camera-facing tiles first. The existing
`reselect(camera)` already transforms the camera into the globe's spinning
local frame; ordering a step's tile list by dot product against the camera
forward vector is sufficient and needs no new machinery. Tiles behind the
globe refine last and, under a budget, may never refine at all — which is
correct.

### 4.3 In-flight budget

Requests go through the single existing worker bridge (`requestRegion` →
`{type:'region'}` → `deliverRegion`). Cap in-flight requests at a small
constant (start at 4) and drain the queue in priority order, so a camera move
mid-cascade re-prioritizes rather than waiting out a stale queue. The
worker is serial regardless; the cap exists to keep the queue re-orderable,
not to create parallelism.

### 4.4 What does not change

Region tiles already mesh through the same `buildGridGeometry`/skirt core as
base tiles and already colour through the lens via a per-tile colour source
(`RegionScene` carries the field names the lens reads). Mixed-level
boundaries are already crack-filled by skirts. The incremental per-slot
rebuild diff in `globe.ts` already disposes and builds individual slots. The
cascade is a *scheduling* change on top of machinery that exists; it is not a
new rendering path.

## 5. The tiles export is demoted, not retired

This is the correction that most shapes the work. `RegionScene` does **not**
carry everything `TilesScene` does. Missing, and each one has a live consumer:

```
  FIELD                       CONSUMER                          IF DROPPED
  -------------------------   -------------------------------   ----------------------
  width / height              lockedClimate.ts (locked lens)     locked worlds break
  tDiurnalAmpC                diurnal temperature lens           lens breaks
  currentEast / currentNorth  views/currents.ts (The Gyre)       overlay disappears
  cloudType                   views/clouds.ts                    layer disappears
  features                    globe.ts site markers, ui/inspect   settlements vanish
```

A region-first globe that simply stopped calling `hw_scene_tiles` would
silently drop clouds, ocean currents, the diurnal lens, and every settlement
marker. So the export stays — it just stops being the source of surface
detail and becomes the source of *global overlay and feature data*.

The pleasant consequence: once the export is no longer carrying surface
resolution, its width is free to go **down**. `tilesWidth` becomes a knob
governing cloud-texture and current-field resolution only. 256 is the
starting proposal (~0.4 s instead of ~1.4 s), tunable by eye — this is a
presentation choice, exactly the kind decision 0022 leaves to the client.

Capability probes in `main.ts` (`circulationBands`, `currentEast.some(...)`,
`cloudType.some(...)`) read the export and are unaffected.

## 6. Code changes

- **`src/views/cubeSphere.ts`** — `LOD_MIN_LEVEL` 1 → 2. This is what makes
  level 2 the resting base rather than a transient.
- **`src/views/globe.ts`** — `REGION_MIN_LEVEL` 3 → 0, so the base levels
  are region-served. A new cascade scheduler: an ordered queue of pending
  tile requests with an in-flight cap, seeded at mount with steps 2–4 and
  re-prioritized on camera move. `regionsEnabled` gating unchanged (§8.2).
- **`src/main.ts`** — `tilesWidth: 512` → `256` (§5). An earlier draft also
  called for a first-paint trigger firing on step 2 rather than on the export
  landing; that is not achievable and has been dropped. `mountViews` needs the
  tiles document before it can construct anything at all — the ocean, ice,
  lens, and marker layers all take it as a constructor argument — so the
  export necessarily gates first paint. Demoting it to width 256 is what makes
  that gate cheap (~0.4 s of export instead of ~1.4 s); the cascade then
  starts from an already-mounted globe. The width choice moves into
  `worker.ts`, which knows the world's `dayLengthDays` after genesis.
- **`src/views/lens.ts`, `ocean.ts`, `ice.ts`** — untouched. They read
  through the per-tile colour source, which already accepts a region patch.

The one genuinely new unit is the scheduler, and it should be a pure module
(`src/views/cascade.ts`) taking a tile list plus a camera vector and
returning an ordered queue — testable without three.js, in the shape the
rest of `src/views/` already uses.

## 7. Non-goals

- **Rendering the far side at level 2.** Budget-ordered refinement means back
  tiles may stay coarse indefinitely. That is the design working.
- **Parallel wasm instances.** See §8.3.
- **Raising `samples` above 64.** A separate, later knob (CLAUDE.md already
  names it). At 318 ms per patch, `samples=128` would make the level-2 step
  ~30 s; it belongs to the deepest CDLOD tiles only, not the base.
- **Cross-face adjacency.** Untouched, as in The Excursion.
- **Any client-side interpolation to "fill in" detail between samples.**
  Choosing where to sample is presentation. Synthesizing values between
  samples would be inventing precision the producer never emitted — the one
  thing decision 0022 forbids. The cascade selects sample locations; it never
  manufactures sample values.

## 8. Risks and open questions

### 8.1 Rebuild churn — mostly already solved

An earlier draft of this section claimed the rebuild throttle was still open
and had to land first. That was wrong, and reading `globe.ts` before planning
corrected it. The Massing already shipped the machinery:

- `drainBuildQueue` builds at most `MAX_BUILDS_PER_FRAME` (6) tiles per frame
  under a `BUILD_BUDGET_MS` (5 ms) time budget, called every frame from
  `update`. A big refine sharpens over ~10 frames instead of freezing one.
- `applyTileSet` only *reconciles* — it enqueues builds and marks undesired
  tiles `retiring`, and `coveringMounted` defers their disposal until the
  tiles replacing them are mounted, so a refine is hole-free.
- On-settle gating (`gateRefinement`, `SETTLE_EPSILON`,
  `SETTLE_FRAMES_NEEDED`) defers *refining* changes while the camera is
  moving, so a fling holds its detail instead of rebuilding every frame.
- `LOD_MERGE_FACTOR` hysteresis already prevents split/merge thrash at the
  threshold.

What CLAUDE.md lists as open is narrower than "no throttle": it is churn from
repeated *reselection* under an unfrozen diurnal spin while zoomed in, for
which freeze-spin is the current answer. The cascade does not make that worse.

Two real residual risks remain, and both are addressed by tasks in the plan:

1. **The initial mount is not amortized.** `rebuildAllTiles(tilesAtLevel(
   LOD_MIN_LEVEL))` builds every base tile synchronously, outside the queue.
   At `LOD_MIN_LEVEL = 1` that is 24 tiles; at 2 it is 96, which would hitch
   badly. The initial mount has to route through `buildQueue` first.
2. **Region requests have no explicit rate control.** They fire inside
   `buildTileSlot`, so today they are implicitly capped at 6/frame by the
   build cap. Making the base region-served raises their number sharply and
   gives them an ordering requirement the current call site cannot express.

### 8.2 Locked worlds

`regionsEnabled` requires `sys.world.dayLengthDays !== null` because the
locked-temperature lens needs `width`/`height` that a patch lacks. Under this
design a locked world would fall back to the export-only path at
`tilesWidth: 256` — i.e. it would get *worse* than today. Either the fallback
keeps `tilesWidth: 512` for locked worlds (cheap, ugly, correct), or the
producer adds what `lockedClimate.ts` needs to `scene/tiles-region/v1` (the
real fix, and the top item on the Hornvale wishlist §9).

### 8.3 Worker pool

Tempting — 8 instances would parallelize the cascade — but each instance pays
`hw_new` (~2.8 s) plus its own `SceneContext` build (~1.2 s) before serving a
single patch. For a cascade whose total producer time is ~10 s, four seconds
of per-worker startup buys little. Determinism makes it *safe* (same seed,
byte-identical worlds, so patches from different workers agree at shared
edges); the arithmetic makes it premature. Revisit if `hw_new` shrinks.

### 8.4 Memory

96 level-2 tiles at 65² nodes is ~406k vertices — fewer than a 1024-wide
export's 524k, but they are live `BufferGeometry` rather than a parsed
array, and the region JSON cache (`regionCache`) retains every patch by key.
An eviction policy for distant patches is not in scope here but will be
needed before the CDLOD levels below the base are cascaded too.

## 9. Hornvale wishlist this implies

Not required to start; each raises the ceiling.

1. **Region-doc parity for `lockedClimate`** — unblocks §8.2, the only place
   this design makes something worse.
2. **Binary payload** — natively, `hw_scene_tiles(512)` is 151 ms to build
   and 383 ms to serialize; JSON is 72% of the cost. Applies to every patch.
3. **Hoist `triangle_weights`** (`region.rs:390-401`) — five `interp` calls
   per node across only two geospheres, weights recomputed all five times.
   ~2× on the region marginal, no contract change.
4. **`samples > 256`** — only matters once §7's deep-tile knob is taken up.

## 10. Testing

- **`cascade.ts` unit tests** — ordering is camera-facing-first; the in-flight
  cap is respected; a camera move re-prioritizes a partially-drained queue;
  the queue is exhausted exactly once per tile.
- **`globe.test.ts`** — extend the existing region-swap tests to the base
  levels: a level-0 mount upgrades in place when its patch arrives; the
  globe is never hole-y mid-cascade (the existing amortized-refine test is
  the right shape to copy).
- **Golden safety** — `testdata/` goldens are producer samples and are
  untouched by a scheduling change; `catalogFixture.test.ts` continues to
  pin the parse.
- **e2e** — the existing smoke asserts a non-blank globe after boot. First
  paint moving from step 1 to step 2 should *help* it. Note that this suite
  is timeout-marginal under software WebGL on a loaded dev machine (the lens
  roster test lands at ~3.7 min against a 240 s budget and flakes there); CI
  is the authority for e2e, not local runs.
