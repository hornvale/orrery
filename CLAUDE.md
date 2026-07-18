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
npm run wasm:release   # fetch the pinned release (e.g. world-wasm-v6) + verify sha
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
npm run e2e       # playwright: boots seed 42 in a real browser, helm + lenses
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
  `moonShading.ts`/`moonTexture.ts`, `starfield.ts`, `system.ts`, and the LOD
  scaffolding `cubeSphere.ts` / `worldMesh.ts` / `regionPatch.ts` / `scale.ts`
  / `zoom.ts`.
- `src/ui/` — `hud.ts`, `inspect.ts`, `seed.ts`, `infoCard.ts`.
- `src/state/url.ts` — deep-link state (seed/view/day in the hash).

## The two patterns you'll reuse

**Adding a lens** costs *one file* (`src/views/lens.ts`): its own colormap,
legend, and caption. No HUD edit. Colormaps are presentation-only.

**Adding a globe display toggle** threads one path, every layer pure and
unit-tested: a `View` method (e.g. `OceanView.setGlint`) → a `GlobeView`
forwarder → a HUD callback + active-class setter (`hud.ts`, and its `noop` in
`hud.test.ts` needs the new callback) → `main.ts` state + wiring. The winds,
waves, glint, night-fill, and freeze-spin toggles are all this shape — copy
one.

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

**Still open (unblocked, client-side):** deeper levels currently *interpolate*
the 512-wide tile data (smoother silhouette, no new detail). For TRUE higher-res
terrain, consume the producer's `scene/tiles-region/v1` patches (`regionPatch.ts`
parses them; the producer emits them) in the near tiles. Also: a rebuild
throttle if an unfrozen diurnal spin while zoomed-in ever churns rebuilds (the
freeze-spin toggle is the current answer).
