# The Excursion — Design

**Ticket:** hornvale/orrery MAP-70 (idea-registry row added at close, following MAP-65..68's convention)
**Date:** 2026-07-23
**Status:** Shipped 2026-07-23 (campaign *The Excursion*, registry MAP-70)
**Parent contracts:** hornvale-repo idea-registry rows MAP-65 (The Vantage — Map region addressing, `#view=map` not URL-addressable), MAP-67 (The Diorama — the `MapStyle` switch, fixed-isometric camera), MAP-68 (The Overworld — the pixel renderer this leaves untouched) — `book/src/frontier/idea-registry.md` in the `hornvale` repo, not this one; their own orrery-repo spec files were pruned from this worktree post-merge, per this project's convention. Also hornvale-repo `book/src/chronicle/the-region.md` + `windows/scene/src/region.rs` (`tiles_region_scene`, `RegionAddr`) for the tile-addressing contract this consumes unchanged (both verified present).
**Upstream work required: none.** `tiles_region_scene` already accepts arbitrary `(face, level, ix, iy)`; every neighbor tile this campaign fetches uses the same existing wasm export.

## 1. Problem

The Map rung's camera is completely static: `mapView.ts` builds a fixed-pose
orthographic camera for each style (`applyPixelCamera`/`applyIsoCamera`) with
no pan or zoom control wired to it at all — `mapCanvas`'s `pointerEvents` are
toggled on view-switch (`main.ts`) but nothing listens on them. Nathan: "the
camera needs to be able to zoom in and out and pan via dragging." Separately,
the flat map's sprite-based ocean "wave" marks (`~~`, `symbols/sprites.ts`'s
`buildWaveMaterial`) "look wretched and don't match" — a leftover from before
the Overworld renderer shipped its own crafted coastlines (shallows band,
outline, foam), which now carries that visual honestly.

Adding real camera movement immediately exposes a second, harder problem:
`mapView.setRegion` mounts exactly **one** region tile. Pan far enough in any
direction and the camera looks at genuine unrendered void — not because
there's nothing there conceptually (the world is a sphere), but because
nothing beyond the one mounted tile has ever been fetched.

## 2. Goal

Real pan (drag) and zoom (wheel) camera controls for the Map rung, working
identically for both `MapStyle`s (the fixed camera *angle* — top-down for
pixel, isometric for voxel — never changes; only position/zoom do). Panning
reveals real neighboring terrain via a same-face, same-level ring of tiles
loaded around the current center, not a void. The already-built-but-dormant
zoom-driven symbol rung gets wired up now that real zoom exists. The ocean
wave sprites are removed.

**Non-goal, explicitly:** panning across a **cube-face boundary** (as
opposed to a tile boundary within one face). No adjacency-remapping exists
anywhere in the codebase — client or Rust — for the six-face cube topology
(24 edge cases, plus face corners where three faces meet, which are a
strictly harder case than edges). Building that is a separate, future
project. This campaign clamps at the face edge.

## 3. Camera controls

One `THREE.OrthographicCamera` already exists (`mapView.ts`'s `camera`,
shared by both styles). Attach one `MapControls` instance (`three/addons/
controls/MapControls.js`, already vendored — the pan-primary `OrbitControls`
variant, mirroring how `system` uses `OrbitControls` and `globe` uses
`ArcballControls`) to it, with `enableRotate = false`: left-drag pans,
wheel zooms, right-drag is a no-op (rotate disabled). `screenSpacePanning`
stays at `MapControls`' own default (`false`) — panning moves along the
ground plane rather than the tilted screen plane, which is correct for both
the top-down pixel camera and the tilted isometric voxel camera.

One instance serves both styles: `setStyle` still calls
`applyPixelCamera`/`applyIsoCamera` to reset the fixed pose on a style
switch, then re-syncs `controls.target` and calls `controls.update()` so
`MapControls` picks up the new pose rather than fighting it.

`minZoom`/`maxZoom` are bound to the mounted ring's extent (§4) — sized so
zooming out reveals the whole ring without exposing its own edge, and
zooming in stops at a reasonable single-tile close-up.

**The pan bound must be an explicit, active constraint** — not an emergent
consequence of "there's nothing to render past the edge." Left unconstrained,
`MapControls` will happily pan the camera target arbitrarily far past the
last mounted or face-clamped tile into a blank scene, which is exactly the
void-at-the-edge failure this campaign exists to kill, just relocated to the
ring's boundary. `MapControls`' pan delta is clamped each `change` event to
the ring's current valid footprint (whatever is mounted, or a face edge).

## 4. Neighbor-tile ring

A new map-specific module — **not** a refactor of `globe.ts`'s sphere-wide
LOD system, whose tile selection is camera-distance-driven across all six
faces and would be the wrong tool for a fixed-level local neighborhood.
Reuses the existing worker request/cache *pattern* (key by
`face:level:ix:iy:samples`, dispatch through the same `requestRegion` /
worker-reply bridge `main.ts` already owns), scoped down to one face.

### Ownership

The cache moves **into `mapView.ts`'s closure**, mirroring how `globe.ts`
already owns its own `regionCache: Map<string, RegionScene>` and
`regionPending: Set<string>` internally (`globe.ts:483-484`) rather than
`main.ts` tracking it. Concretely:

- `createMapView(requestRegion)` takes the same `requestRegion` function
  `createGlobeView` already receives, and owns its own `regionCache` /
  `regionPending`.
- `mapView` gains an `onRegion(key, region)` method, structurally identical
  to globe's (`globe.ts:975-984`): cache the arrival, drop it from pending,
  and mount it if it's in the currently-active ring. A reply for a key the
  map no longer wants (dropped by a recenter before the reply arrived) is a
  no-op except for the cache-vs-halo check below.
- `main.ts`'s `deliverRegion` drops `pendingMapKey` entirely and calls
  `mapView.onRegion(key, region)` unconditionally, exactly parallel to the
  `globeView.onRegion(key, region)` call already on the line above it. The
  map decides internally whether it cares.

### Two radii, not one

- **Hot ring, radius 1** (`MAP_RING_RADIUS`, first-pass value): the 3×3
  same-face/same-level tiles actually mounted as meshes.
- **Warm halo, radius 2** (`MAP_CACHE_HALO_RADIUS`, first-pass value):
  `RegionScene`s kept in `regionCache` but not mounted. A tile leaving the
  hot ring (the user panned away) is unmounted immediately but its
  `RegionScene` stays cached — a quick pan back and forth across the same
  boundary re-mounts from cache with no new worker round-trip. A tile
  leaving the warm halo entirely is dropped from `regionCache` for real.
  Without this second, larger bound, a session that roams steadily in one
  direction for a long time would accumulate an ever-growing cache of
  `RegionScene`s (each carrying several `Float64Array`s of per-node data)
  for the life of the page — the hot/warm split is what keeps that bounded.

### Fetch timing: eager, not lazy

The entire radius-1 ring (all 8 neighbors) is requested the moment a region
is set — at the globe→map handoff, or after a recenter — not lazily as the
camera approaches each edge. `maxZoom` is sized off the full ring's extent
(§3); if neighbors only fetched on approach, zooming out immediately after
arriving in Map view would show the ring's own blank edges before anything
loaded — the same void problem, one layer further out.

### Coordinate frame: stable, never floating

Ring members are laid out in **one stable local space**, addressed by
`(Δix, Δiy)` offset from the tile that was center *when the region was
first set* — this offset origin is never re-zeroed. A naive "current center
tile is always at local origin" convention would require re-zeroing the
coordinate frame under the camera on every tile-boundary crossing — a
floating-origin problem that would actively fight `MapControls`, whose drag
handler accumulates screen-space deltas into world-space camera motion
*mid-gesture*: teleporting the frame under an active drag would jump the
view or corrupt the drag. A radius-1 ring is small enough in world units
that no true floating-origin machinery is needed — just the discipline of
never moving the origin. "Recenter" (below) is therefore purely a
bookkeeping operation over which addresses to fetch/mount/dispose; it never
repositions the camera or any existing mesh.

### Recenter, with hysteresis

When `controls.target` (the ground-plane point `MapControls` pans/zooms
around) crosses from the current center tile's footprint into a neighbor's,
the ring recenters: shift which address is
"center," request the newly-exposed ring edge, unmount tiles now outside the
hot ring (demoting them to warm-halo-cached, per above). This needs a
hysteresis margin — crossing must be solid, not a bare touch of the boundary
line — or a user idling or dragging near a tile edge thrashes: repeatedly
unmounting and remounting (even if served from cache) on every frame the
cursor wobbles across the line. A margin fraction of a tile-width past the
boundary before recentering fires (`RECENTER_HYSTERESIS_FRACTION`,
first-pass value) is the spatial equivalent of `globe.ts`'s own frame-settle
hysteresis on its distance-based LOD reselection (`SETTLE_FRAMES_NEEDED`) —
same shape of problem, spatial instead of temporal because the trigger here
is a drag position, not a discrete resolution threshold.

### Face-edge clamp

If a would-be neighbor's `ix`/`iy` would leave `[0, 2^level)`, that ring slot
is left unfetched and unmounted, and the camera's pan bound (§3) stops at
that edge rather than attempting a request for a nonexistent address.

### Style switch

Switching `MapStyle` (pixel ↔ voxel) rebuilds **every currently-mounted ring
member**, not just the center, from `regionCache` — no new worker requests,
since every mounted tile's `RegionScene` is already resident.

### Region change (a genuine fly-to, not a pan-crossing)

A real `setRegion(newAddress)` call — the globe→map handoff landing on a
different tile than before — clears `regionCache` and `regionPending`
entirely and fetches a fresh eager ring around the new center. This is
different from a recenter: a recenter reuses most of the existing ring, a
region change discards all of it.

## 5. Zoom-driven symbol rung

`mapView.ts`'s `mountPixel` currently hardcodes the symbol overlay
(peaks/forests/icons) to `'near'`, with a comment noting it's fixed "until
the map camera drives it." A `rungForMapZoom(cameraZoom)` — parallel to the
globe's existing `rungForZoom(visibleAngularRadiusRad)`
(`symbols/budget.ts:30-34`) but keyed on the orthographic camera's `.zoom`
factor instead of an angular radius — replaces the hardcoded value, feeding
`MapSymbols.update(rung)` whenever zoom changes materially.

**Symbols mount on the center tile only.** `RUNG_BUDGETS` (up to 150 peak
sprites at `'near'`) was tuned assuming exactly one tile's worth of symbols.
Mounting the overlay on all 9 hot-ring tiles could put ~1,350 peak sprites
on screen at once — a budget nobody sized for and a genuine clutter/perf
risk. Neighbor ring tiles render terrain with no symbol overlay; re-tuning
budgets for a multi-tile symbol field is out of scope here.

## 6. Remove wave symbols

Delete `buildWaveMaterial` (`symbols/sprites.ts`), the `waveStride`/`waves`
fields from `RungBudget`/`RUNG_BUDGETS` (`symbols/budget.ts`), and the
wave-placement loop, `waveMaterial` variable, and its dispose entry
(`mapSymbols.ts`). Drop `'wave'` from `place()`'s `kind` union. Peaks,
forests, and biome-signature icons (volcano/cactus/mushroom) are untouched.
No replacement ocean marker is needed — the Overworld renderer's crafted
coastlines (shallows band, dark outline, foam) already carry the ocean edge
honestly; the sprite waves were a second, now-clashing treatment of the same
thing.

## 7. Testing

- **Unit:** ring-selection math (given a center address and radius,
  correct same-face neighbor keys; face-edge clamp at `ix`/`iy = 0` and
  `= 2^level - 1`); hot/warm eviction (a tile beyond the warm halo is fully
  dropped from cache, one within it is retained-but-unmounted);
  `rungForMapZoom` threshold mapping; symbol tests pruned of every wave
  assertion, confirming peaks/forests/icons are unaffected.
- **e2e (Playwright):** drag-pan across a tile boundary mounts the new
  neighbor and (after the hysteresis margin) unmounts the far tile; a quick
  back-and-forth pan across the same boundary does not trigger a second
  worker request (cache hit); wheel-zoom changes visible extent within
  `minZoom`/`maxZoom`; panning toward a face edge clamps without throwing
  or issuing an invalid-address request; style-switch while panned to a
  neighbor rebuilds the full visible ring, not just the center.
- **Visual pass:** screenshot pan/zoom in both styles to confirm ring tiles
  seam without gaps or z-fighting at tile boundaries, and that pixel-style
  oceans still read fine without the sprite waves.

## 8. Non-goals

- **Cross-face-boundary panning.** No adjacency-remapping table exists for
  the cube's six faces (edges or, harder still, corners where three faces
  meet). Panning clamps at a face edge; stitching across it is a distinct
  future project that can build on this campaign's ring-loading machinery.
- **Multi-tile symbol budgets.** Symbols stay center-tile-only (§5);
  re-tuning `RUNG_BUDGETS` for a full ring is a follow-up if it's ever
  wanted.
- **Elastic/rubber-band clamp feel.** The face-edge clamp is a hard stop.
  A softer "give" at the edge (iOS-scroll-bounce-style) is a plausible
  polish follow-up, not a requirement here.
- **Any producer-side or wasm change.** `tiles_region_scene` already
  supports every address this campaign requests; no catalog version bump,
  no hornvale commits.
- **Pixel-art palette/resolution aesthetic tuning** (the Overworld
  campaign's own deferred headline followup) — out of scope; Nathan is
  satisfied with the current pixel-art look.

## 9. Flagged for G3

1. **No epoch, no save-format, no determinism-contract implications.**
   Client-side (Orrery) only; `tiles_region_scene`'s existing contract is
   read unchanged at new addresses. No census exposure, no AWS spend.
2. **First-pass tunable constants** (`MAP_RING_RADIUS`, `MAP_CACHE_HALO_
   RADIUS`, `RECENTER_HYSTERESIS_FRACTION`, `minZoom`/`maxZoom`) are
   design-stage placeholders in the sense that their *existence* and
   *relationship* (ring ⊂ halo, zoom bounds ⊂ ring extent) are load-bearing
   and specified here, but their exact numeric values are implementation/
   visual-pass tuning, consistent with how every prior view-remake campaign
   shipped first-pass values as named constants.
3. **Reached via two ideonomy passes**, both converged: pass 1 (substitution
   + combination, cycle organon) surfaced eager-ring-fetch, the stable-frame
   requirement, recenter hysteresis, center-tile-only symbols, style-switch-
   rebuilds-from-cache, and explicit cache-clear-on-region-change. Pass 2
   (abstraction-lift + cross-domain re-instantiation, tree organon)
   confirmed the hysteresis finding independently, added the explicit
   active-clamp requirement and the hot/warm two-radius cache bound, and
   checked (found nothing missing) whether HUD or URL state needed to track
   the current tile — neither exists today, so there's nothing to
   desynchronize. No overturns of the design's shape in either pass.
