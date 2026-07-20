# Orrery performance — before/after (The Frame Budget)

Measured by `e2e/perf-harness.spec.ts` (Playwright + Chrome CDP CPU profile +
frame-gap / long-task stats + render-independent `buildTiles` counters). Headless
software-GL inflates render time; the render-INDEPENDENT counters (`buildTiles`
call-count + JS ms) and the flamegraph are the trustworthy JS-lever metrics.
Smoothness on real hardware is judged by the controller's visual pass.

## Zoom-in (deep zoom on seed 42, globe view)

| Metric | Baseline (origin/main @a3ff771) | After |
|---|---|---|
| frame-gap p50 (ms) | 1782 | **150** |
| frame-gap p95 (ms) | 3067 | **180** |
| frame-gap max (ms) | 4089 | **271** |
| frames > 100ms | 50 / 50 | — |
| long-task total (ms) | 86635 | **11330** |
| long-task max (ms) | 4098 | **194** |
| buildTiles calls | (instrumented in T3) | — |

**After T2 (analytic normals):** flamegraph — `stitchNormals` ELIMINATED (35% -> ~2% `analyticNormal`); `buildTiles` per-call cost collapsed (52% -> ~5% of CPU, ~12s -> ~4s absolute), since the O(all-vertices) stitch was most of a rebuild. Frame-gap unchanged (the ~30x rebuild FREQUENCY remains -> T3). Visual: no tile-boundary seams; relief reads. 450 tests green.

**Flamegraph (baseline):** `buildTiles` ~52% of CPU, `stitchNormals` ~35%
(`keyAt` string-building ~12%), running ~30× per zoom as the CDLOD leaf set
changes each frame + on region arrivals. The globe is effectively frozen
(~1 fps) during a zoom.

_Filled in as each lever lands (analytic normals, incremental LOD diff,
incremental region, buffer reuse, the sweep)._

**After T3 (incremental LOD diff + hysteresis + on-settle):** frame-gap p50
**1782 → 150ms (~12×)**, long-task total **86.6s → 11.3s (~8×)**, max frame
**4089 → 271ms**. The diff builds only split/merged tiles per LOD change (not
all ~40); region arrivals swap a single tile (pendingUpgrades). Headless
software-GL still floors the frame time; on real hardware (fast GPU) the now-
tiny JS makes it smoother still. Visual: refinement correct, no gaps/duplicates/
seams/thrash. 460 tests green.

## The sweep (T6) — the other interactions

Measured each interaction's flamegraph. **The zoom was the only JS-bound
hotspot.** All others are render-bound (headless software-GL rasterization — a
measurement artifact the real GPU handles fast; no main-thread JS lever):

| Interaction | JS share | Verdict |
|---|---|---|
| Zoom | (fixed) | `buildTiles`/`stitchNormals` — fixed 12× by T2+T3 |
| Day-scrub (temperature lens) | ~1.7% (`repaint`/`colorAt`/`diurnalWaveform`) | render-bound; no JS lever |
| Lens-swap | ~0.5% (`repaint` 32ms total) | render-bound; no JS lever |
| Boot | wasm genesis + render dominate; `parseTiles` trivial | not a JS hotspot |

"Go as deep as it takes" bottoms out here: the JS work is exhausted. The one
unmeasurable-in-headless real-HW lever is draw-call count (many per-tile meshes),
but reducing it fights the per-tile-mesh architecture the incremental diff needs,
so it is left un-chased (no measurement to justify the risk).
