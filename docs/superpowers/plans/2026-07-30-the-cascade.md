# The Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The globe takes its surface from a coarse-to-fine cascade of region patches (6 level-0 faces → 24 level-1 → 96 level-2) instead of one fixed-resolution equirect export, reaching 1024-equivalent detail without a 1024-wide export.

**Architecture:** A new pure scheduler module (`src/views/cascade.ts`) owns request ordering and the in-flight cap; `globe.ts` submits to it instead of calling `requestRegion` inline. The existing amortized build machinery (`buildQueue`/`drainBuildQueue`) is reused unchanged, with the initial mount routed through it. Then `LOD_MIN_LEVEL` goes 1→2 and `REGION_MIN_LEVEL` 3→0 so the base levels are region-served, and the tiles export is demoted to width 256 for overlays only.

**Tech Stack:** TypeScript, three.js 0.166, vitest, Vite. No new dependencies.

## Global Constraints

- **Never invent precision.** The cascade selects *where* to sample. It must never synthesize sample values between samples (spec §7). Colour and elevation always come from a producer document.
- **Presentation is deliberately non-deterministic** (decision 0022) — ordering, timing, and pacing are free client choices; do not add determinism tests over them.
- **The gate is four commands, all must pass before any push:** `npm test`, `npm run smoke`, `npm run build`, `npm run e2e`. e2e is timeout-marginal locally; CI (now running on PRs into main) is the authority for it.
- **`public/hornvale_world.wasm` is gitignored** and required by ~15 wasm-fixture tests. Run `npm run wasm:release` first if absent. Pinned to `world-wasm-v13`.
- **Region patches are requested at `samples = TILE_QUADS` (64).** Do not raise this in the campaign (spec §7).
- **`RegionScene` lacks `width`/`height`, `tDiurnalAmpC`, `currentEast`/`currentNorth`, `cloudType`, `features`** (spec §5). The tiles export stays for these; never assume a region patch can serve them.

---

### Task 1: The cascade scheduler

A pure module: given tiles wanted and a camera direction, decide what to request next and how many may be in flight. No three.js, no globe state.

**Files:**
- Create: `src/views/cascade.ts`
- Test: `src/views/cascade.test.ts`

**Interfaces:**
- Consumes: `TileId`, `tileKey`, `tileCenterUnit`, `type V3` from `./cubeSphere` (all already exported).
- Produces:
  - `createCascade(opts?: { maxInFlight?: number; maxAttempts?: number }): Cascade`
  - `interface Cascade { submit(tiles: readonly TileId[]): void; reprioritize(cameraUnit: V3): void; next(): TileId[]; settle(tile: TileId, ok: boolean): void; readonly pending: number; readonly inFlight: number; }`
  - `const CASCADE_MAX_IN_FLIGHT = 4`
  - `const CASCADE_MAX_ATTEMPTS = 2`

**Retry policy (Nathan's ruling, 2026-07-30).** `settle` takes an explicit
`ok`. A successful patch retires the tile permanently. A *failed* one is
retried on a later `submit` until it has been attempted `CASCADE_MAX_ATTEMPTS`
times, after which it retires too.

This departs from `main.ts:147`'s existing policy ("Left uncleared so a
persistently-failing region isn't re-requested every rebuild"), deliberately.
That policy is safe today because only deep zoom tiles use patches — a failure
costs detail nobody is looking at. Task 4 makes the *base* globe patch-served,
so the same failure would leave a permanently coarse tile in the default view.
Bounding the retry at 2 keeps the storm the old comment feared off the table.

- [ ] **Step 1: Write the failing test**

Create `src/views/cascade.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CASCADE_MAX_IN_FLIGHT, createCascade } from './cascade';
import { tileCenterUnit, tileKey, type TileId } from './cubeSphere';

const t = (face: number, level = 0, ix = 0, iy = 0): TileId => ({ face, level, ix, iy });

describe('cascade scheduler', () => {
  it('hands out no more than the in-flight cap at once', () => {
    const c = createCascade();
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    expect(c.next().length).toBe(CASCADE_MAX_IN_FLIGHT);
    expect(c.next().length).toBe(0); // cap is saturated until something settles
  });

  it('releases capacity as tiles settle', () => {
    const c = createCascade({ maxInFlight: 2 });
    c.submit([t(0), t(1), t(2)]);
    const first = c.next();
    expect(first.length).toBe(2);
    c.settle(first[0]!);
    expect(c.next().length).toBe(1);
  });

  it('orders camera-facing tiles first', () => {
    const c = createCascade({ maxInFlight: 6 });
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    // Face 1's centre, as the camera direction: face 1 must come out first.
    c.reprioritize(tileCenterUnit(t(1)));
    const order = c.next().map(tileKey);
    expect(order[0]).toBe(tileKey(t(1)));
  });

  it('reprioritizes a partially drained queue without redealing in-flight tiles', () => {
    const c = createCascade({ maxInFlight: 2 });
    c.submit([t(0), t(1), t(2), t(3), t(4), t(5)]);
    const dealt = c.next();
    const dealtKeys = dealt.map(tileKey);
    c.reprioritize(tileCenterUnit(t(5)));
    for (const d of dealt) c.settle(d); // free both slots
    const after = c.next().map(tileKey);
    // The re-sorted queue leads with face 5, and nothing already dealt recurs.
    expect(after[0]).toBe(tileKey(t(5)));
    for (const k of after) expect(dealtKeys).not.toContain(k);
  });

  it('never deals the same tile twice', () => {
    const c = createCascade({ maxInFlight: 10 });
    c.submit([t(0), t(1)]);
    c.submit([t(0), t(1)]); // duplicate submit is a no-op
    const dealt = c.next();
    expect(dealt.length).toBe(2);
    expect(c.pending).toBe(0);
  });

  it('exhausts exactly once: a settled tile is not re-dealt', () => {
    const c = createCascade({ maxInFlight: 4 });
    c.submit([t(0), t(1)]);
    const dealt = c.next();
    for (const d of dealt) c.settle(d);
    expect(c.next()).toEqual([]);
    expect(c.pending).toBe(0);
    expect(c.inFlight).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/cascade.test.ts`
Expected: FAIL — `Failed to resolve import "./cascade"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/views/cascade.ts`:

```ts
/** Request scheduling for the globe's region patches (The Cascade).
 *
 * Pure: no three.js, no globe state, no producer calls. Given the tiles the
 * globe wants patches for and where the camera is looking, decide which to
 * ask for next and how many may be outstanding at once.
 *
 * The worker serving these is serial regardless, so the in-flight cap is not
 * about parallelism — it is about keeping the queue RE-ORDERABLE. A camera
 * move mid-cascade should re-prioritize what has not been asked for yet
 * rather than waiting out a stale queue. */
import { tileCenterUnit, tileKey, type TileId, type V3 } from './cubeSphere';

/** Outstanding requests allowed at once. Small on purpose: the queue can only
 * be re-prioritized ahead of what has already been dealt. */
export const CASCADE_MAX_IN_FLIGHT = 4;

export interface Cascade {
  /** Add tiles wanting patches. Already-pending, in-flight, and settled tiles
   * are ignored, so callers may submit the same set every frame. */
  submit(tiles: readonly TileId[]): void;
  /** Re-sort what has not yet been dealt, camera-facing first. */
  reprioritize(cameraUnit: V3): void;
  /** Take the next batch to request, respecting the in-flight cap. */
  next(): TileId[];
  /** Mark a dealt tile as resolved (patch arrived, or failed), freeing a slot. */
  settle(tile: TileId): void;
  readonly pending: number;
  readonly inFlight: number;
}

export function createCascade(opts?: { maxInFlight?: number }): Cascade {
  const cap = opts?.maxInFlight ?? CASCADE_MAX_IN_FLIGHT;
  let queue: TileId[] = [];
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const settled = new Set<string>();
  // Camera direction as of the last reprioritize; identity ordering until then.
  let camera: V3 | null = null;

  const score = (t: TileId): number => {
    if (camera === null) return 0;
    const c = tileCenterUnit(t);
    // Dot product against the camera direction: larger = more camera-facing.
    // Negated so a plain ascending sort puts facing tiles first.
    return -(c[0] * camera[0] + c[1] * camera[1] + c[2] * camera[2]);
  };

  return {
    submit(tiles) {
      for (const t of tiles) {
        const k = tileKey(t);
        if (queued.has(k) || inFlight.has(k) || settled.has(k)) continue;
        queued.add(k);
        queue.push(t);
      }
      if (camera !== null) queue.sort((a, b) => score(a) - score(b));
    },
    reprioritize(cameraUnit) {
      camera = cameraUnit;
      queue.sort((a, b) => score(a) - score(b));
    },
    next() {
      const out: TileId[] = [];
      while (queue.length > 0 && inFlight.size < cap) {
        const t = queue.shift()!;
        const k = tileKey(t);
        queued.delete(k);
        inFlight.add(k);
        out.push(t);
      }
      return out;
    },
    settle(tile) {
      const k = tileKey(tile);
      inFlight.delete(k);
      settled.add(k);
    },
    get pending() {
      return queue.length;
    },
    get inFlight() {
      return inFlight.size;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/cascade.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run build
git add src/views/cascade.ts src/views/cascade.test.ts
git commit -m "feat(the-cascade): the region-request scheduler

A pure module owning request ordering and the in-flight cap. The worker is
serial, so the cap is not about parallelism — it keeps the queue re-orderable
so a camera move mid-cascade re-prioritizes what has not been asked for yet."
```

---

### Task 2: Amortize the initial base mount

`rebuildAllTiles(tilesAtLevel(LOD_MIN_LEVEL))` builds every base tile synchronously at mount, outside `buildQueue`. At today's `LOD_MIN_LEVEL = 1` that is 24 tiles; Task 4 makes it 96, which would hitch hard. Route it through the queue first, so Task 4 is a constant change and not a performance cliff.

**Files:**
- Modify: `src/views/globe.ts:777` (the initial `rebuildAllTiles` call) and the `applyTileSet`/`drainBuildQueue` region above it
- Test: `src/views/globe.test.ts`

**Interfaces:**
- Consumes: `applyTileSet(selected: TileId[]): void`, `drainBuildQueue(): void`, `MAX_BUILDS_PER_FRAME`, `tilesAtLevel(level: number): TileId[]` — all already defined in `globe.ts`.
- Produces: no new exports. Behavioural contract: after `createGlobeView(...)` returns, `spinGroup.children.length` is at most `MAX_BUILDS_PER_FRAME`, and repeated `update(...)` calls drive it to the full base set.

- [ ] **Step 1: Write the failing test**

`globe.test.ts` uses bare `test(...)`, not `describe`/`it`. Its helpers are
`makeGlobe()` (line ~623, no arguments — `createGlobeView(seed42Tiles,
seed42System)`), `tileMeshesByKey(view)` (line ~100, reads mounted tiles back
out of the scene graph by their `globe-tile-<key>` names), and `pump(view,
camera, n = 48)` (line ~111). Use these; do not add new ones.

Add to `src/views/globe.test.ts`:

```ts
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
```

`GLOBE_RADIUS` is already imported in this file.

Add `LOD_MIN_LEVEL` to the existing `./cubeSphere` import in the test file.

> **Why `<= 6` is the right bound:** the suite lifts `__buildBudgetMs` globally
> (see the comment above `makeGlobe`) so the drain is governed by
> `MAX_BUILDS_PER_FRAME` (6) rather than wall-clock, which makes this
> deterministic across fast and slow machines. Do not remove that hook.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/globe.test.ts -t "through the build queue"`
Expected: FAIL — the mounted count equals the whole base set (24) rather than ≤ 6.

- [ ] **Step 3: Write minimal implementation**

In `src/views/globe.ts`, the initial mount currently reads:

```ts
  // Initial coarse set (the data-matching base level); the camera refines it.
  rebuildAllTiles(tilesAtLevel(LOD_MIN_LEVEL));
```

`rebuildAllTiles` is defined above `buildQueue`, so it cannot enqueue. Move the initial mount to *after* `drainBuildQueue` is defined (i.e. after the function ends, around line 920) and replace it with a reconcile-then-drain:

```ts
  // Initial base set, amortized exactly like any later refine: reconcile the
  // desired set (which enqueues every tile), then drain one frame's worth.
  // The rest arrive over the following frames via `update` → `drainBuildQueue`.
  // Building all of them here would hitch — at LOD_MIN_LEVEL 2 that is 96
  // tiles in one synchronous burst.
  applyTileSet(tilesAtLevel(LOD_MIN_LEVEL));
  drainBuildQueue();
```

Delete the old `rebuildAllTiles(tilesAtLevel(LOD_MIN_LEVEL));` line at 777.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/views/globe.test.ts`
Expected: PASS, including the new test and all ~39 existing ones.

If existing tests fail because they assumed a fully-mounted globe immediately after construction, pump frames in those tests (`for (let i = 0; i < 40; i++) view.update(0, undefined);`) rather than reverting this change — the amortized mount is the intended new behaviour.

- [ ] **Step 5: Commit**

```bash
npm run build
git add src/views/globe.ts src/views/globe.test.ts
git commit -m "perf(the-cascade): amortize the initial base mount

rebuildAllTiles built every base tile synchronously at mount, outside the
build queue. That is tolerable at 24 tiles and not at 96, which is where
LOD_MIN_LEVEL 2 takes it. Reconcile-then-drain instead, so the initial mount
is paced by the same per-frame budget every later refine already uses."
```

---

### Task 3: Route region requests through the cascade

Region requests currently fire inline in `buildTileSlot` (two call sites, lines ~606 and ~633), deduped only by `regionPending`. They have no ordering and no cap beyond the incidental 6/frame from the build cap. Move them behind the scheduler.

**Files:**
- Modify: `src/views/globe.ts` — the two `requestRegion!(t)` call sites, the `onRegion` handler (~line 975), and `update` (~line 1186)
- Test: `src/views/globe.test.ts`

**Interfaces:**
- Consumes: `createCascade`, `type Cascade` from `./cascade` (Task 1).
- Produces: no new exports. Behavioural contract: at most `CASCADE_MAX_IN_FLIGHT` outstanding `requestRegion` calls; `onRegion` and the region-error path both settle their tile.

- [ ] **Step 1: Write the failing test**

A globe that takes a `requestRegion` callback is built directly, the way the
existing region tests do it (lines ~132, ~203, ~222, ~252):
`createGlobeView(markerTiles([]), spinningSys(), [], requestRegionFn)`.
`spinningSys()` matters — a locked system disables regions entirely. Region
documents come from `regionFixture(face, level, ix, iy, samples)` (line ~84).

Add to `src/views/globe.test.ts`:

**This task runs while `REGION_MIN_LEVEL` is still 3** (Task 4 lowers it), so a
tile only wants a patch once the camera has zoomed deep enough to subdivide
past level 3. Use the same deep-zoom camera the existing region tests use
(`GLOBE_RADIUS * 1.001`, see the "onRegion swaps only the arriving tile" test)
— a default `PerspectiveCamera` sits at the origin, inside the globe, and
reaches nothing. Also call `view.setLens(moistureLens)`: `regionFixture` fills
only `elevation_m` and `moisture`, so the default lens's ice blend would read
a field the fixture lacks.

```ts
test('caps outstanding region requests at the cascade in-flight limit', () => {
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => { requested.push(t); });
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera);
  // Nothing has been delivered, so nothing settles and the cap must hold —
  // however many frames we pump.
  expect(requested.length).toBeGreaterThan(0); // the deep zoom did reach REGION_MIN_LEVEL
  expect(requested.length).toBeLessThanOrEqual(CASCADE_MAX_IN_FLIGHT);
});

test('resumes requesting once delivered patches settle', () => {
  const requested: TileId[] = [];
  const view = createGlobeView(markerTiles([]), spinningSys(), [], (t) => { requested.push(t); });
  view.setLens(moistureLens);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(GLOBE_RADIUS * 1.001, 0, 0);
  pump(view, camera);
  const firstBatch = [...requested];
  expect(firstBatch.length).toBeGreaterThan(0);

  // Deliver them all; the cascade frees its slots and deals the next batch.
  for (const t of firstBatch) {
    view.onRegion(tileKey(t), regionFixture(t.face, t.level, t.ix, t.iy, TILE_QUADS));
  }
  pump(view, camera);
  expect(requested.length).toBeGreaterThan(firstBatch.length);
});
```

Import `CASCADE_MAX_IN_FLIGHT` from `./cascade`. `TILE_QUADS`, `tileKey`,
`type TileId`, `GLOBE_RADIUS`, and `moistureLens` are already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/globe.test.ts -t "cascade in-flight limit"`
Expected: FAIL — request count exceeds the cap, because requests fire per build with no scheduler.

- [ ] **Step 3: Write minimal implementation**

In `src/views/globe.ts`:

1. Import the scheduler alongside the existing `./cubeSphere` import:

```ts
import { createCascade } from './cascade';
```

2. Create it next to `regionCache`/`regionPending` (~line 483):

```ts
  // Region requests go through the cascade scheduler rather than firing
  // inline at build time: it orders them camera-facing-first and caps how
  // many are outstanding, so a camera move re-prioritizes what has not been
  // asked for yet instead of waiting out a stale queue.
  const cascade = createCascade();
```

3. Replace **both** inline request sites. Each currently reads:

```ts
        if (wantsRegion && !regionPending.has(key)) {
          regionPending.add(key);
          requestRegion!(t);
        }
```

Replace each with a submission (the scheduler owns dedupe, so `regionPending` is no longer needed at these sites):

```ts
        if (wantsRegion) cascade.submit([t]);
```

4. In `update`, after the existing `drainBuildQueue()` call, deal the next batch. Where `update` has the camera available, reprioritize first:

```ts
    // Deal the next region requests. Camera-facing tiles go first; the cap
    // keeps the tail of the queue re-orderable for the next camera move.
    if (requestRegion !== undefined) {
      if (camera !== undefined) cascade.reprioritize(cameraUnitFor(camera));
      for (const t of cascade.next()) {
        regionPending.add(tileKey(t));
        requestRegion(t);
      }
    }
```

Use the same camera→globe-local-frame transform `reselect` already performs; factor it into a small `cameraUnitFor(camera): V3` helper beside `reselect` and call it from both, rather than duplicating the maths.

5. In `onRegion` (~line 975), settle the tile so its slot frees:

```ts
    cascade.settle(keyToTile(key));
```

6. In `main.ts`'s `region-error` branch, the tile must also settle or the cap leaks a slot permanently. Add a `deliverRegionError(key)` to the view's returned object mirroring `onRegion`, calling `cascade.settle(keyToTile(key))`, and call it from the `region-error` handler in `main.ts:146`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/views/globe.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add src/views/globe.ts src/views/globe.test.ts src/main.ts
git commit -m "feat(the-cascade): route region requests through the scheduler

Requests fired inline at build time, unordered and capped only incidentally
by the per-frame build budget. They now go through the cascade: camera-facing
first, at most CASCADE_MAX_IN_FLIGHT outstanding. The region-error path
settles too, so a failed patch does not leak an in-flight slot."
```

---

### Task 4: Flip the base to region-first

The constants change, and the cascade is seeded with the level ladder.

**Files:**
- Modify: `src/views/cubeSphere.ts:134` (`LOD_MIN_LEVEL`), `src/views/globe.ts:482` (`REGION_MIN_LEVEL`) and the initial mount from Task 2
- Test: `src/views/cubeSphere.test.ts`, `src/views/globe.test.ts`

**Interfaces:**
- Consumes: `createCascade` (Task 1), the amortized initial mount (Task 2), the scheduler wiring (Task 3).
- Produces: `LOD_MIN_LEVEL === 2`; `REGION_MIN_LEVEL === 0`.

- [ ] **Step 1: Write the failing test**

In `src/views/cubeSphere.test.ts`:

```ts
it('the base level resolves the 1024-equivalent grid', () => {
  // Four equatorial faces x (2^level tiles) x TILE_QUADS samples per tile
  // edge is the effective equirect column count of the base mesh.
  expect(4 * 2 ** LOD_MIN_LEVEL * TILE_QUADS).toBe(1024);
});
```

In `src/views/globe.test.ts`:

```ts
it('requests region patches for the base level, not just deep tiles', () => {
  const requested: TileId[] = [];
  const view = makeGlobe({ requestRegion: (t) => { requested.push(t); } });
  for (let i = 0; i < 40; i++) view.update(0, undefined);
  // With REGION_MIN_LEVEL 0 the base set itself wants patches, so a globe
  // sitting at its default framing requests them without any zoom.
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every((t) => t.level <= LOD_MIN_LEVEL)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/cubeSphere.test.ts -t "1024-equivalent" src/views/globe.test.ts -t "base level"`
Expected: FAIL — `4 * 2**1 * 64` is 512, not 1024; and no requests are made at the default framing because `REGION_MIN_LEVEL` is 3.

- [ ] **Step 3: Write minimal implementation**

In `src/views/cubeSphere.ts`, replace the `LOD_MIN_LEVEL` declaration and its doc comment:

```ts
/** Base LOD level. Level 2 is 4 tiles x TILE_QUADS (64) = 256 samples per
 * face edge, so the four equatorial faces resolve 1024 equirect columns —
 * twice the old 512-wide export the base used to be matched to. The base is
 * region-served now (The Cascade), so this is no longer bounded by the
 * export's width. */
export const LOD_MIN_LEVEL = 2;
```

In `src/views/globe.ts`, replace `REGION_MIN_LEVEL`:

```ts
  // Every level is region-served now (The Cascade): the base globe is built
  // from patches rather than resampled from the tiles export, so the export's
  // width stops bounding the globe's detail.
  const REGION_MIN_LEVEL = 0;
```

Then seed the cascade so it can order the whole base set, keeping Task 2's mount:

```ts
  // Seed the cascade with the entire base set so `reprioritize` can order all
  // 96 camera-facing-first. Without this the queue holds only the ~6 tiles
  // drained so far when the first reprioritize runs, and ordering degrades to
  // face-major build order. `submit` dedupes, so this changes WHICH tiles get
  // requested not at all — only the order.
  if (regionsEnabled) cascade.submit(tilesAtLevel(LOD_MIN_LEVEL));
```

> **AMENDED 2026-07-30 (Nathan's ruling).** This step originally seeded a
> coarse-to-fine ladder — `applyTileSet(tilesAtLevel(0))`, a drain, then
> `cascade.submit` for levels 1 and 2. That was wrong on two counts, both
> confirmed by review against the code:
>
> 1. `coveringMounted` spans only one level. A retiring level-0 tile under a
>    level-2 selection has level-1 `childTiles` (none selected) and a `null`
>    `parentTile`, so it returns `true` and disposes immediately — all six
>    level-0 tiles gone while 96 replacements are still queued, leaving 6/96
>    coverage for ~15 frames.
> 2. A level-0 patch pass is 6 × `TILE_QUADS` = 256 equirect columns against
>    the export's 512. The ladder would have spent ~2.5 s of producer time to
>    fetch *lower* resolution than the client already held, and `selectTiles`
>    never emits a leaf below `LOD_MIN_LEVEL`, so levels 0-1 are unrenderable
>    regardless.
>
> The coarse pass is the export; the cascade's job is the refinement. See spec
> §4.1, amended to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Existing tests asserting a 24-tile base set must be updated to `6 * 4 ** LOD_MIN_LEVEL` (96) — derive it from the constant rather than hardcoding, so the next change does not break them again.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add src/views/cubeSphere.ts src/views/globe.ts src/views/cubeSphere.test.ts src/views/globe.test.ts
git commit -m "feat(the-cascade): region-serve the base globe at level 2

LOD_MIN_LEVEL 1 -> 2 and REGION_MIN_LEVEL 3 -> 0. The base mesh resolves 1024
equirect columns against the old 512, and gets them from region patches
rather than resampling the export — so the producer's width <= 1024 cap stops
bounding globe detail. Mount seeds a level-0 globe, then refines through 1
to 2 via the cascade."
```

---

### Task 4a: Amortize the style and relief rebuilds

**Added 2026-07-30 (Nathan's ruling) after Task 4's review.** `setStyle` and
`setTrueRelief` both call `rebuildAllTiles(currentSelected)`, which disposes
and rebuilds every mounted slot in one synchronous loop — no queue, no time
budget. Task 2 amortized the *initial mount*; these two callers survived, and
Task 4 quadrupled their cost by taking the base set from 24 tiles to 96.

Measured in Task 4's own test run: the voxel style repaint went from ~1460 ms
to ~4186 ms solo, and ~12518 ms under contention. Four tests needed their
timeouts raised to `30_000` to survive it. That is a user-visible freeze on
every style or relief toggle, and it is a regression this campaign introduced.

**Files:**
- Modify: `src/views/globe.ts` — the `setTrueRelief` and `setStyle` bodies, and `rebuildAllTiles`
- Test: `src/views/globe.test.ts`

**Interfaces:**
- Consumes: `applyTileSet`, `drainBuildQueue`, `buildQueue`, `tileSlots` — all existing in `globe.ts`.
- Produces: no new exports. Behavioural contract: after `setStyle(...)` or `setTrueRelief(...)` returns, no more than `MAX_BUILDS_PER_FRAME` tiles have been rebuilt; pumping frames completes the rest.

- [ ] **Step 1: Write the failing test**

```ts
test('setStyle rebuilds through the queue, not all at once', () => {
  const view = makeGlobe();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, GLOBE_RADIUS * 40);
  pump(view, camera); // settle the full base set first

  const before = performance.now();
  view.setStyle('voxel');
  const sync = performance.now() - before;

  // The synchronous part of a style switch must not scale with the base set.
  // Rebuilding all 96 tiles inline is what this guards against.
  expect(sync).toBeLessThan(1_000);

  // Pumping completes the switch: every mounted tile ends up voxel geometry.
  pump(view, camera);
  expect(tileMeshesByKey(view).size).toBe(6 * 4 ** LOD_MIN_LEVEL);
});
```

A wall-clock assertion is a blunt instrument and normally I would avoid one,
but the defect IS wall-clock and the margin is large (measured ~4200 ms
against a 1000 ms bound). If it proves flaky on CI, replace it with a counter:
instrument `buildTileSlot` calls behind a `globalThis` hook the way
`__btCount` and `__swapCount` already are, and assert the synchronous portion
rebuilds at most `MAX_BUILDS_PER_FRAME`. Prefer the counter if it is
straightforward — it is the better test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/globe.test.ts -t "setStyle rebuilds through the queue"`
Expected: FAIL — the synchronous rebuild takes seconds.

- [ ] **Step 3: Write the implementation**

Route both callers through the queue. `rebuildAllTiles(selected)` currently
disposes and rebuilds inline; give it (or a sibling) a form that instead marks
the mounted slots for rebuild and enqueues them, letting `drainBuildQueue`
pace the work exactly as a LOD refine already is.

The subtlety to get right: a style or relief change rebuilds tiles *in place*
— the same keys stay selected. That is the `pendingUpgrades` shape (a same-key
rebuild that disposes and replaces atomically when built), not the
retiring/`coveringMounted` shape, so it needs no hole-free deferral. Reuse the
existing same-key path rather than inventing a second one.

Keep `rebuildAllTiles`'s doc comment accurate — it currently claims it serves
"the initial mount", which Task 2 removed, and omits `setStyle` entirely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Several style/relief tests read rebuilt geometry immediately
after the call; those now need a `pump` first. That is the correct fix — the
rebuild is amortized now. Also REMOVE the four `30_000` timeouts Task 4 added
(`globe.test.ts`, the style tests) — they were an accommodation for this
defect and should not outlive it. If the suite's wall time drops noticeably,
say so in the report.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add src/views/globe.ts src/views/globe.test.ts
git commit -m "perf(the-cascade): amortize the style and relief rebuilds

setStyle and setTrueRelief rebuilt every mounted slot synchronously. Task 2
amortized the initial mount; these two callers survived it, and Task 4
quadrupled their cost by taking the base set from 24 tiles to 96 — the voxel
repaint went ~1460ms to ~4186ms solo and ~12518ms under contention.

Both now enqueue and let drainBuildQueue pace them, the same amortization
every LOD refine already uses. The four 30s test timeouts added to survive the
slow path are removed with it."
```

---

### Task 5: Demote the tiles export

The export stops carrying surface detail and becomes the overlay/feature source, so its width can drop. Locked worlds, which cannot use region patches, keep the old width.

**Files:**
- Create: `src/sim/tilesWidth.ts`, `src/sim/tilesWidth.test.ts`
- Modify: `src/main.ts:156` (drop `tilesWidth` from the `generate` message), `src/sim/worker.ts:73,80` (choose the width from the parsed system)

There is no `src/main.test.ts`; `src/sim/worker.test.ts` exists. The width
logic goes in its own module so it is testable without the worker's message
plumbing.

**Interfaces:**
- Consumes: nothing new.
- Produces: `TILES_WIDTH_OVERLAY = 256`, `TILES_WIDTH_LOCKED = 512`, and `tilesWidthFor(world: { dayLengthDays: number | null }): number`, all from `src/sim/tilesWidth.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/sim/tilesWidth.test.ts` (this directory's tests use `describe`/`it`
— see `scene.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { TILES_WIDTH_LOCKED, TILES_WIDTH_OVERLAY, tilesWidthFor } from './tilesWidth';

describe('tiles export width', () => {
  it('demotes a spinning world to the overlay width', () => {
    expect(tilesWidthFor({ dayLengthDays: 1 })).toBe(TILES_WIDTH_OVERLAY);
  });

  it('keeps the full width for a locked world, which cannot use region patches', () => {
    expect(tilesWidthFor({ dayLengthDays: null })).toBe(TILES_WIDTH_LOCKED);
  });

  it('only ever asks for widths the producer accepts (even, 16..=1024)', () => {
    for (const w of [TILES_WIDTH_OVERLAY, TILES_WIDTH_LOCKED]) {
      expect(w % 2).toBe(0);
      expect(w).toBeGreaterThanOrEqual(16);
      expect(w).toBeLessThanOrEqual(1024);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/tilesWidth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/sim/tilesWidth.ts`:

```ts
/** How wide to request the `scene/tiles/v1` export.
 *
 * Since The Cascade the globe's surface comes from region patches, so this
 * export no longer carries surface detail — it carries what a region patch
 * cannot (spec §5): cloud type, ocean currents, settlement features, and the
 * width/height the locked-temperature evaluator needs. At that job a coarser
 * grid is enough, and the export is ~4x cheaper.
 *
 * A tidally-locked world is the exception: `regionsEnabled` excludes it (the
 * locked lens needs width/height a patch lacks), so its globe is still built
 * from this export and it keeps the full width. */
export const TILES_WIDTH_OVERLAY = 256;
export const TILES_WIDTH_LOCKED = 512;

export function tilesWidthFor(world: { dayLengthDays: number | null }): number {
  return world.dayLengthDays === null ? TILES_WIDTH_LOCKED : TILES_WIDTH_OVERLAY;
}
```

The width must be chosen once the world's `dayLengthDays` is known, which is *after* genesis — but the tiles export is requested as part of the same worker `generate` message. Resolve this in `src/sim/worker.ts`: it already has the system scene before it calls `catalog.sceneTiles(tilesWidth)`, so compute the width there from the parsed system rather than passing it in from `main.ts`. Change the `generate` handler to ignore an incoming `tilesWidth` and call `tilesWidthFor(...)` on the parsed system's world instead. Remove `tilesWidth: 512` from the `postMessage` in `main.ts:156`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run smoke`
Expected: PASS. `smoke` matters here — it drives the real wasm and would catch a width the producer rejects (`MIN_WIDTH..=MAX_WIDTH`, and width must be even).

- [ ] **Step 5: Commit**

```bash
npm test && npm run smoke && npm run build
git add src/sim/tilesWidth.ts src/sim/tilesWidth.test.ts src/sim/worker.ts src/main.ts
git commit -m "feat(the-cascade): demote the tiles export to overlay width

The globe's surface comes from region patches now, so the export only has to
carry what a patch cannot: cloud type, currents, features, and the
width/height the locked evaluator needs. 512 -> 256 for spinning worlds,
~4x cheaper. Locked worlds keep 512 — regionsEnabled excludes them, so the
export is still their globe."
```

---

### Task 6: Close the campaign

**Files:**
- Modify: `CLAUDE.md` (the LOD status section), `docs/superpowers/specs/2026-07-30-the-cascade-design.md` (status line)

- [ ] **Step 1: Update the spec status**

Change the header line to `**Status:** Shipped 2026-07-<dd>` with the merge date.

- [ ] **Step 2: Update CLAUDE.md's LOD status**

The section currently says region patches are a near-camera treatment gated to `REGION_MIN_LEVEL = 3`, and lists "CDLOD levels past a region's own `samples` re-interpolate" as the open knob. Rewrite it to describe the cascade: the base is region-served at level 2, the export is demoted to overlays at width 256, and the remaining open items are raising `samples` for the deepest tiles and region-doc parity for locked worlds.

- [ ] **Step 3: Fix the e2e fixed-wait race Task 4a introduced**

**Added after Task 4a's review.** `e2e/smoke.spec.ts:172` does
`await page.waitForTimeout(400)` after a style switch. That was safe when
`setStyle` rebuilt every tile synchronously before returning — it no longer
does. Rebuilds are now paced at `MAX_BUILDS_PER_FRAME` (6) per frame, so 400 ms
is a bet on frame rate: ~96 tiles needs ~16 frames, which is fine at 60 fps and
not fine on a loaded box under software WebGL.

Replace the fixed sleep with a readiness check. The globe already instruments
`globalThis.__btCount` / `__swapCount` / `__slotBuildCount`; expose or reuse a
signal for "the build queue is drained" and poll it with Playwright's
`expect.poll` or `page.waitForFunction`, with a generous timeout. Do not simply
raise the 400 to a bigger number — that reintroduces the same bet at a
different threshold.

Check whether any other fixed `waitForTimeout` in `e2e/` has the same problem
now that rebuilds are amortized, and fix those too.

- [ ] **Step 4: Run the full gate**

```bash
npm test && npm run smoke && npm run build && npm run e2e
```

Expected: all four green. e2e is timeout-marginal under software WebGL on a
loaded dev box; if it flakes locally after the readiness fix, push and let CI
adjudicate — but a flake here is now evidence the readiness check is wrong,
not just noise, so investigate before dismissing it.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-07-30-the-cascade-design.md
git commit -m "docs(the-cascade): close — CLAUDE.md LOD status, spec shipped"
```

---

## Notes for the implementer

**Verify before you assume.** This plan was written against `globe.ts` as of `07e9f50`. Line numbers will drift as you work; the anchors are the identifier names (`applyTileSet`, `drainBuildQueue`, `REGION_MIN_LEVEL`, `regionPending`), not the numbers.

**`globe.test.ts` has ~39 existing tests and its own fixtures.** Read the top of the file before adding tests. Several construct globes and assert mounted tile counts; Tasks 2 and 4 will break some of them legitimately. Fix them by pumping frames and deriving counts from `LOD_MIN_LEVEL`, never by reverting the behaviour under test.

**Do not touch `lens.ts`, `ocean.ts`, or `ice.ts`.** They read through the per-tile colour source, which already accepts a region patch (`colorSrc` is cast to `TilesScene` and `RegionScene` carries the field names the lens reads). If you find yourself editing them, something upstream is wrong.

**Watch the locked-world path throughout.** `regionsEnabled` is `requestRegion !== undefined && sys.world.dayLengthDays !== null`. Every task must leave a locked world working via the export-only path — Task 5 is where that is explicitly preserved, but Tasks 2 and 4 must not assume region patches exist.

**If a task's premise turns out to be wrong, stop and say so** rather than forcing the step. Two premises in the parent spec were already wrong on inspection (§5's field parity and §8.1's throttle); a third is entirely possible.
