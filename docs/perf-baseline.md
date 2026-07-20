# Orrery performance — before/after (The Frame Budget)

Measured by `e2e/perf-harness.spec.ts` (Playwright + Chrome CDP CPU profile +
long-task / frame-gap stats + a render-INDEPENDENT `buildTiles`/`applyTileSet`
counter: JS call-count and JS ms). **Headless runs a software rasterizer**, so
frame-gap and long-task numbers are dominated by render time and are NOT a valid
cross-version metric — they even *invert* (see below). The trustworthy,
render-independent lever metric is the **JS tile-build main-thread work**
(`buildTiles_total_ms` + call count) and the flamegraph's JS share. Smoothness on
real hardware is the controller's visual pass.

## The measurement trap this campaign fell into (and caught)

A mid-campaign reading showed the zoom at a flat ~150ms/frame and the
render-independent counters at **zero** — apparently a huge win. It was a bug.
The incremental-diff work introduced an on-settle refinement gate that measured
camera motion in the globe's **spinning** local frame; under autoplay the world
turns every frame, so the gate never released and the globe **never refined**
past the coarse set or streamed a region while the clock ran. The "150ms" was
refinement being *suppressed*, not accelerated — zero tile work because no tile
work ever fired.

It was caught exactly as systematic debugging predicts: the render-independent
counter read 0 while the frame-gap looked great, and a camera-trajectory probe
showed `moved=true` on every frame even with the camera dead still. Fixed in
`fix(globe): settle LOD refinement on the world-space camera, not the spinning
frame` — settle now keys off the user's world-space camera pose (the spun frame
stays for tile *selection* only). A regression test (stationary camera, advancing
day) locks it: it fails on the spun-frame gate, passes on the fix.

## Zoom-in (deep zoom on seed 42, globe view) — same harness, both versions

The `buildTiles`/`applyTileSet` JS counter is new on this branch, so the baseline
column was produced by checking the four `a3ff771` view files back into the tree
and instrumenting the old `buildTiles` with the identical `__btCount`/`__btMs`
increment (then reverting). Same harness, same interaction, same counter shape —
but the baseline counter was a deliberate ad-hoc port, not code that ever shipped
at `a3ff771`.

| Metric | Baseline (a3ff771) | Fix | 
|---|---|---|
| **JS tile-build work (ms)** — the real lever | **13875** | **795** (**~17× less**) |
| tile-build calls | 34 full rebuilds | 23 incremental applies |
| per-call cost (ms) | ~408 / full rebuild | ~35 / incremental apply (~12× cheaper) |
| region arrivals | full-globe rebuild each | 8 single-tile swaps, 0 full rebuilds |
| frame-gap p50 (ms) — render-bound, see note | 522 | 1457 |
| long-task total (ms) — render-bound | 26510 | 74093 |

**Read the JS row, not the frame-gap row.** The baseline disposes and rebuilds
*every* mounted tile on each change (34× over the scripted zoom), reconciling
normals across every vertex via a string-keyed map (`stitchNormals`) — ~408ms of
main-thread JS per rebuild, 13.9s total. The fix builds only the tiles that split
or merged in (analytic normals need no cross-tile stitch) and swaps a streamed
region into its single tile — ~35ms per apply, 0.8s total. **~17× less
main-thread blocking for the same interaction.**

The frame-gap *inverts* (fix looks slower) because the fix, working correctly,
holds and renders far more level-4 detail once settled; the headless software
rasterizer then floors every frame drawing it. On real hardware the GPU draws
that for free, and the 17× main-thread reduction is what makes the zoom glide.
The headless frame-gap cannot see this — hence the render-independent counter.

## Where the analytic-normals move shows up

Baseline's ~408ms/rebuild includes `stitchNormals` — an O(all-vertices) pass over
a `Map` keyed by a freshly-allocated coordinate string per vertex (the T1
flamegraph put it at ~35% of a rebuild). Analytic normals (each vertex normal
from the elevation field's slope, a pure function of lat/lon, so shared tile edges
agree by construction) delete that pass and its allocation entirely — which is
also what lets a single tile be built or swapped in isolation, the property the
incremental diff depends on.

## The sweep (T6) — the other interactions

Each interaction's flamegraph, JS share only (the render-bound rest is a headless
artifact the GPU handles):

| Interaction | JS share | Verdict |
|---|---|---|
| Zoom | (fixed) | full-rebuild + stitchNormals → incremental + analytic; ~17× less JS |
| Day-scrub (temperature lens) | ~1.7% (`repaint`/`colorAt`/`diurnalWaveform`) | render-bound; no JS lever |
| Lens-swap | ~0.5% (`repaint`) | render-bound; no JS lever |
| Boot | wasm genesis + render dominate; `parseTiles` trivial | not a JS hotspot |

"Go as deep as it takes" bottoms out here: the zoom was the only JS-bound hotspot,
and after the fix its JS is 0.8s of genuine work. The one real-HW lever the
headless harness cannot measure is draw-call count (many per-tile meshes), but
reducing it fights the per-tile-mesh architecture the incremental diff needs, so
it is left un-chased (no measurement to justify the risk) — a follow-up.
