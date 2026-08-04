# CLAUDE.md — the Orrery (hornvale/orrery)

The Orrery is Hornvale's **3D planetarium client** — a dependency-free
three.js app (Vite + TypeScript) that runs genesis in the browser via the
world-wasm catalog and renders the system and the globe. Live at
<https://hornvale.github.io/orrery/>. Formerly `goldengrove`; the three.js
views descend from bitterbridge/goldengrove, the ephemeris/scene modules from
Hornvale's retired in-book orrery client. This is a **separate repo** from the
`hornvale` monorepo (extracted in hornvale commit `62577e79`).

## The one principle that governs everything: sim emits data, client renders

Hornvale decision **0022**. The simulation ships **numbers**; this client
turns them into a picture. Two hard consequences:

- **Presentation here is deliberately NON-deterministic** — the exact opposite
  of hornvale, where byte-identity is constitutional. Colors, camera, lighting,
  animation are client choices. Do not import hornvale's determinism anxieties
  into a rendering change.
- **Never invent precision.** If the producer doesn't ship a field, the client
  must not fabricate it. Moisture has no mm/yr calibration; temperature is
  purely **seasonal** (`t_mean + t_swing·sin` over the year — no diurnal term);
  ocean currents aren't emitted at all. Rendering any of these as if the data
  existed is dishonest precision. When a feature needs data the producer lacks,
  the fix is a **producer-side change in `hornvale/windows/scene`** (then a new
  catalog version) — not a client-side invention. This is why "watch
  temperature drop over a night" and "flowing ocean currents" are blocked here.

Where the client *does* evaluate the producer's own math (ephemeris positions,
the seasonal temperature curve), it is **golden-pinned** to producer samples
(`testdata/*.json|csv`, checked in `src/sim/*.test.ts`) — the two
implementations are pinned to each other, not hoped to agree.

## The catalog wasm is never committed (decision 0052)

`public/hornvale_world.wasm` is gitignored. CI fetches the tagged release;
locally you build/fetch it yourself before tests will pass:

```bash
npm run wasm:release   # fetch the pinned release (world-wasm-v14) + verify sha
npm run wasm:local     # OR copy a local hornvale world-wasm build
```

Without it, the ~15 wasm-fixture tests (`src/testHelpers/wasmFixture.ts`) fail
and everything else passes — a missing-wasm failure is an environment gap, not
a regression. When hornvale ships new scene fields, the catalog version bumps
(a `chore: re-pin catalog to world-wasm-vN` commit) and `testdata/` goldens
are regenerated from the new producer.

## The gate (matches CI `deploy.yml`) — no separate linter

```bash
npm test          # vitest: co-located *.test.ts (needs the wasm for fixtures)
npm run smoke     # node: hw_new + scene doc sanity over the wasm
npm run build     # tsc --noEmit + vite build (the typecheck IS the lint)
npm run e2e       # playwright: boots seed 42 in a real browser, the console's
                  # tabs/rungs/lenses/Looks, plus a 375px/390px mobile pass
```

Run all four before pushing. `npm run dev` for the live app. e2e needs the
browser: `npx playwright install chromium` (as your user, not sudo — a
root-cache browser is invisible to the test run).

## Module map

- `src/sim/` — the **producer contract**: `scene.ts` (parse/validate the
  `scene/tiles/v1` + `scene/tiles-region/v1` documents), `climate.ts` /
  `lockedClimate.ts` (the seasonal temperature evaluator — golden-pinned),
  `ephemeris.ts` / `moon.ts` (orbital positions — golden-pinned), `catalog.ts`
  (the wasm loader), `worker.ts`, `palette.ts`.
- `src/time/` — `clock.ts`, `calendar.ts`, `speedPolicy.ts` (per-rung playback
  rates; the spin/clock coupling lives here).
- `src/views/` — the three.js layer: `globe.ts` (the world), `ocean.ts`,
  `winds.ts`, `ice.ts`, `lens.ts` (+ `colormap.ts`, `biomePalette.ts`),
  `look.ts` (the one Look axis — globe mesh, surface material, map rung, and
  post passes, replacing the old three separate style axes), `moonShading.ts`/
  `moonTexture.ts`, `starfield.ts`, `system.ts`, and the LOD scaffolding
  `cubeSphere.ts` / `worldMesh.ts` / `regionPatch.ts` / `cascade.ts` (the
  region-request scheduler) / `scale.ts` / `zoom.ts`.
- `src/ui/` — the control surface: `src/ui/controls/` (`kinds.ts`'s four
  control kinds — toggle/choice/slider/action — plus `registry.ts`, the one
  place every control is declared, and `codec.ts`/`store.ts`, its URL/
  localStorage persistence and live value store), `sheet.ts` (the generic
  tabbed renderer over the registry), `statusBar.ts` (rung buttons, lens/date
  chips, the seed), `transport.ts` (play/pause, the day scrubber, eclipse
  marks), `consoleUi.ts` (assembles the three), `dateField.ts` (the "jump to a
  date" chrome), `inspect.ts`, `seed.ts`, `infoCard.ts`. THREE things are
  deliberate BESPOKE exceptions to the registry — the day scrubber, the info
  card, and the date field. None fits the four generic control kinds (a
  scrubber must distinguish a user drag from autoplay driving it; the info
  card is output, not a control at all; a date field needs text parsing and
  an invalid state) — so they stay hand-wired chrome rather than being forced
  into a kind that doesn't fit them. `kinds.ts` and `dateField.ts` name the
  same three; keep all three documents in step.
- `src/state/` — the state that outlives a frame. `url.ts` is the deep link:
  `seed`/`view`/`day` plus `c=`, the control blob (`ui/controls/codec.ts`
  encodes only what differs from default, so a plain link stays plain).
  `persist.ts` mirrors that same blob into localStorage and owns the
  precedence rule — URL first, local as the fallback. `debounce.ts` is the
  250 ms trailing-edge wrapper the persistence write runs behind (a slider
  drag would otherwise clear Safari's `replaceState` rate limit); its
  `flush()` is what `main.ts`'s `pagehide` listener calls so the last write
  survives a close inside the window.

## The two patterns you'll reuse

**Adding a control** costs *one entry* in `src/ui/controls/registry.ts`: an
`id`, a `label`, a `group`, an `apply`, and optionally an `available()`
predicate that names its own reason for being unavailable. The sheet renders
it, the codec persists it to the URL and localStorage, and e2e addresses it by
`data-control="<id>"` — none of them need editing. `sheet.test.ts` renders from
a *fake* registry precisely so a real control never touches it.

**Adding a lens** still costs *one file* (`src/views/lens.ts`): its own
colormap, legend, and caption. The registry builds the lens picker's options
from `LENSES`, so there is no picker edit either.

**Adding a Look** costs one entry in `src/views/look.ts` — declaring its globe
mesh, its surface material, its map rung, and its post passes — plus its own
settings as `Control` entries if it has any.

## Rendering conventions worth knowing

- **The honest terminator** (spec §4½): one directional sun, no ambient, so
  the night side falls to dark. The opt-in `night fill` ambient is the only
  exception, off by default.
- **The globe camera is a free arcball** (`ArcballControls`, rotate+zoom, pan
  off, target at origin); the **system rung is `OrbitControls`** (top-down,
  up-lock correct). The wheel-handoff between rungs passes distance explicitly
  so it serves both.
- **Spin vs. clock** are decoupled by the seasonal **hold**: freezing the
  mesh spin while the terminator keeps tracking the season (`seasonalSpinZ`,
  `setSeasonalHold`). The `freeze spin` toggle forces it on at any rate.
- **The globe's surface is a two-material swap, not a per-tile choice.**
  `GlobeView.setSurface('standard' | 'dither')` swaps every MOUNTED tile's
  material in place — no geometry rebuild, so a Look switch is instant and
  composes independently of the geometry-family axis (`setStyle`,
  smooth/voxel). A tile built after the swap picks up whichever surface is
  currently active; voxel geometry has no `uv`, so the dither material is
  inert over it and the tile reads as flat-shaded standard regardless.

## LOD status

The globe uses **per-tile CDLOD**: `selectTiles(cameraPos, …)` (cubeSphere.ts)
does a quadtree descent from the six faces, subdividing a tile only while the
camera is within `LOD_SPLIT_FACTOR × edgeLength` of it — so tiles the camera
faces go fine (to `LOD_CDLOD_MAX_LEVEL`) while the far side/back stay at the
`LOD_MIN_LEVEL` base. `globe.ts`'s `reselect(camera)` transforms the camera
into the globe's spinning local frame, selects, and rebuilds only when the
leaf-set signature changes (a still or freeze-spin-held view never rebuilds).
Mixed-level boundaries are crack-filled by **skirts** — `buildTileGeometry`'s
`skirtDepth` apron, double-winded and edge-normal-lit, hidden below the surface
when neighbours match. The whole geometry pipeline is keyed by tile slot, so a
rebuild at any mix of levels is mechanical.

Every tile geometry — base and region alike — also carries a **face-space
`uv`** (`faceSpaceUv`), continuous across the whole cube face rather than
per-tile [0,1]. This is what makes the `dither3d` Look's dots surface-stable:
the dither shader's fractal level is solved from the UV's screen-space
derivative (`dFdx`/`dFdy`), so a per-tile UV would jump discontinuously at
every tile boundary and every LOD refine. Region tiles must pass
`faceSpaceUv(region, …)`, not a resampled per-tile UV, or dot density visibly
jumps when the Cascade refines a tile under the camera.

**The base globe is region-served (The Cascade).** `REGION_MIN_LEVEL` is **0**
— *every* tile the globe can show, base set included, renders from the
producer's `scene/tiles-region/v1` patch (terrain re-sampled at the tile's own
grid) rather than resampled from the equirect export. `LOD_MIN_LEVEL` is **2**,
so the base set is 6·4² = 96 tiles and the four equatorial faces resolve a
1024-column lattice. The globe requests a tile's patch async through `main`'s
worker bridge (`requestRegion` → `{type:'region'}` message → the persisted
post-genesis catalog serves it → `globe.onRegion` caches it → the next reselect
swaps that tile in place). Region tiles mesh through the same
`buildGridGeometry`/skirt core as base tiles and colour through the lens via a
per-tile colour SOURCE (`RegionScene` carries the fields `colorAt`/`iceFraction`
read). Still gated to spinning worlds (`regionsEnabled`): a **tidally locked**
world gets no patches at all and renders from the export alone at every level —
and therefore keeps the **level-1 base** (24 tiles / 512 columns, matched to its
`TILES_WIDTH_LOCKED` export). `globe.ts`'s `baseLevel` follows `regionsEnabled`
for exactly this reason: the finer `LOD_MIN_LEVEL` lattice only pays for itself
when patches arrive to fill it. Without them it is 4× the vertices carrying zero
extra information — interpolation dressed as detail, which decision 0022 forbids.

**The scheduler** (`src/views/cascade.ts`, pure — no three.js, no globe state)
owns which patch is asked for next: dedupe, camera-facing-first ordering
(`reprioritize` sorts what has not been dealt yet), an outstanding-request cap
(`CASCADE_MAX_IN_FLIGHT`, small on purpose so the queue stays re-orderable), and
a bounded retry — a failed request is re-queued until `CASCADE_MAX_ATTEMPTS`,
then retired. Retry exists because a permanently-failed patch is now a coarse
tile in the DEFAULT view, not just missing deep-zoom detail. The retry is
*driven* by `dealRegionRequests` re-submitting the still-patchless selected
tiles every frame: `settle(t, false)` only frees the in-flight slot and counts
the attempt, so without that re-offer a failed base tile — mounted under an
unchanged key, so never rebuilt — would never be asked for again.

**The export is demoted to an overlay.** `TILES_WIDTH_OVERLAY = 256`
(`src/sim/tilesWidth.ts`): the export now carries only what a patch cannot —
cloud type, ocean currents, settlement features, and the `width`/`height` the
locked-temperature evaluator needs. Locked worlds keep `TILES_WIDTH_LOCKED =
512`, since for them the export IS the globe.

**Rebuilds are amortized.** No whole-globe event builds inline: `applyTileSet`,
`enqueueRebuildAll` (`setStyle` across geometry families, `setTrueRelief`) and
the initial base mount only ENQUEUE, and `drainBuildQueue` builds at most
`MAX_BUILDS_PER_FRAME` (6) tiles per frame under a time budget. Undesired tiles
stay rendered as "retiring" until their replacements mount, so a refine never
opens a hole. Consequence for anything driving the globe from outside: **"the
rebuild finished" is a frame count, not a duration** — poll
`globalThis.__buildPending` (the queue depth, 0 = every desired tile mounted)
rather than sleeping. e2e's `waitForGlobeIdle` is the worked example.

**The drain is camera-facing first** (`sortCameraFacingFirst`, shared with the
cascade so the "what next" order of REQUESTS and of BUILDS cannot drift). This
matters because the per-frame budget is wall-clock: on a slow box it affords
**one** build per frame, so a 96-tile base mount spans ~96 frames, and in queue
order the globe fills in from behind — the surface under the camera arriving
last. Measured under a 6× CPU throttle, that was a 44 s boot with the centre of
the globe unclickable throughout (the inspector raycast can only hit a MOUNTED
tile); facing-first makes the centre clickable at 2.6 s with 84 of 96 tiles
still pending. The total drain is unchanged — this is purely which frames buy
which tiles.

**Still open:** (1) CDLOD levels past a region's own `samples` (requested at
`TILE_QUADS`) re-interpolate — raising the requested `samples` for the deepest
tiles is the future knob, untouched by The Cascade. (2) Region-doc parity for
**locked worlds**: they cannot use patches at all until the producer adds
`width`/`height` to `scene/tiles-region/v1` — a producer-side change in
`hornvale/windows/scene`, not a client one. (3) `coveringMounted` only looks one
level up/down, a pre-existing latent bug that is what blocks meshing a level-0
export seed. (4) Before a tile's patch lands, the globe meshes that 1024-column
lattice over 256 columns of export data — it is smoother-LOOKING than its data
for those frames. Also still open: a rebuild throttle if an unfrozen diurnal
spin while zoomed-in ever churns rebuilds (freeze-spin is the current answer).
