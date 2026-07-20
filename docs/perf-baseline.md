# Orrery performance — before/after (The Frame Budget)

Measured by `e2e/perf-harness.spec.ts` (Playwright + Chrome CDP CPU profile +
frame-gap / long-task stats + render-independent `buildTiles` counters). Headless
software-GL inflates render time; the render-INDEPENDENT counters (`buildTiles`
call-count + JS ms) and the flamegraph are the trustworthy JS-lever metrics.
Smoothness on real hardware is judged by the controller's visual pass.

## Zoom-in (deep zoom on seed 42, globe view)

| Metric | Baseline (origin/main @a3ff771) | After |
|---|---|---|
| frame-gap p50 (ms) | 1782 | — |
| frame-gap p95 (ms) | 3067 | — |
| frame-gap max (ms) | 4089 | — |
| frames > 100ms | 50 / 50 | — |
| long-task total (ms) | 86635 | — |
| long-task max (ms) | 4098 | — |
| buildTiles calls | (instrumented in T3) | — |

**Flamegraph (baseline):** `buildTiles` ~52% of CPU, `stitchNormals` ~35%
(`keyAt` string-building ~12%), running ~30× per zoom as the CDLOD leaf set
changes each frame + on region arrivals. The globe is effectively frozen
(~1 fps) during a zoom.

_Filled in as each lever lands (analytic normals, incremental LOD diff,
incremental region, buffer reuse, the sweep)._
