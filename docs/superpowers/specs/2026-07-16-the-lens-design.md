# The Lens — Design

**Ticket:** hornvale/orrery#3 (the data-modes third; pixel-art and drawn-map styles explicitly deferred — §9)
**Date:** 2026-07-16
**Status:** Awaiting G3 review
**Parent contracts:** hornvale `2026-07-16-the-isotherm-design.md` (the climate layers this consumes, and the normative evaluators), decision 0022 (sim emits data, clients render — client-side derivation is presentation, not simulation), `2026-07-15-watery-oceans-design.md` (client-only campaign precedent, this repo's spec home).
**Upstream work required: none.** Every layer this renders already ships in the vendored `world-wasm-v2` binary.

## 1. Problem

Hornvale ships map layers the orrery does not draw. The producer→consumer
pipeline has silently accumulated a rendering debt:

```
  LAYER                shipped   parsed   evaluated   RENDERED
  --------------------------------------------------------------
  elevation_m            yes      yes        -        yes (relief)
  ocean                  yes      yes        -        yes (water)
  biome                  yes      yes        -        yes (color)
  features               yes      yes        -        yes (markers)
  t_mean_c / t_swing_c   yes      yes    temperatureAt   ice only
  season_period_days     yes      yes    temperatureAt   ice only
  circulation_bands      yes      yes      windAt()      NOTHING
  moisture               yes      yes        -           NOTHING
  plate                  yes      NO         -           NOTHING
  unrest                 yes      NO         -           NOTHING
```

Four layers are stuck. `windAt()` (`src/sim/climate.ts`) is a fully
implemented, tested, normatively-specified evaluator that renders zero
pixels. `moisture` is parsed into a typed field with no consumer anywhere in
the codebase. `plate` and `unrest` have shipped since `scene/tiles/v1` and
the client never learned to parse them.

This debt is emergent, not designed: every campaign to date pushed the
producer forward, and only temperature ever found a renderer — as an ice
overlay. The cheapest available payoff is not new data. It is drawing the
data we already send.

## 2. Goal

A **lens registry**: every globe render mode, including today's realistic
view, becomes a registered lens with its own colormap, legend, and honest
caption, selectable from the HUD. Ship six lenses and one overlay, drain all
four stuck layers, and leave a seam where future lenses (population,
transport — hornvale#5's trailing half) cost one file each.

## 3. The central abstraction — everything is a lens

Strip the graphics away and a "data mode" is a pure function
`(tiles, index, day) → rgb`. The consequence that shapes this whole design:
**today's realistic view is already one of those** —
`ocean ? elevationColor(...) : biomeColorForName(...)`, hardcoded at
`src/views/worldMesh.ts:77-79`. It is not a privileged ground truth that data
modes decorate; it is a lens that happens to look like a photograph.

So there is no base mode and no special case. There is a registry of lenses,
one of which is named `natural`.

```ts
interface Lens {
  id: string;                  // 'natural' | 'temperature' | ...
  label: string;               // HUD picker text
  caption: string;             // what this lens exaggerates or invents
  dependsOnDay: boolean;       // does the clock change its colors?
  colorAt(tiles: TilesScene, i: number, day: number): RGB;
  legend(tiles: TilesScene): LegendEntry[];
}
```

Each lens owns its colormap, legend, and caption, so the HUD renders any
registered lens generically and never grows a per-mode branch. This is
Hornvale's constitutional "adding a domain must never require editing an
existing one," re-instantiated client-side.

## 4. The atlas — the campaign-1 roster

```
  LENS           territory                                 alive?  colormap
  ---------------------------------------------------------------------------
  natural        ocean depth + biome (today's view)        no      existing
  topographic    elevation everywhere, sea-level datum     no      sequential
  temperature    temperatureAt(i, day)                     YES     diverging @ 0C
  moisture       moisture index [0,1]                      no      sequential
  plate          plate id                                  no      categorical
  unrest         tectonic unrest                           no      sequential

  OVERLAYS (orthogonal to lens, toggled independently)
  winds          windAt(bands, lat) — arrows/streamlines   no      —
  ice            iceFraction(i, day)                       YES     natural lens only
```

**Only `temperature` is alive.** Everything else is static, which keeps the
per-frame cost exactly where it already is.

**Winds are static** — `windAt(bands, latitudeDeg)` takes no `day` parameter.
The model's prevailing winds never change, because the Isotherm shipped them
as a pure function of latitude and band count ("the model has no per-tile
variance to ship"). The overlay is therefore build-once geometry. On a tidally
locked world `circulationBands` is null and the overlay is unavailable — the
absence is meaningful and the HUD says so rather than hiding the control.

## 5. Architecture

**The seam.** `buildFaceGeometry` takes a colorizer instead of hardcoding the
ternary. That is the entire architectural change: no textures, no shaders, no
material patching.

**Static lenses** bake their colors once at geometry build, exactly as today.

**The one living lens** reuses machinery that already exists. `globe.ts`
already keeps a base-color snapshot and runs `recolorIceInto(geoms, day)`,
setting `color.needsUpdate` and gating on `lastIceDay` so it only pays when
the day changes. Generalizing `recolorIce` to a per-lens recolor driven by
`dependsOnDay` is a rename plus a flag — not new machinery. The ice overlay
is the proof the pattern works.

**The HUD** gains a lens picker, a legend, and the active lens's caption,
all generic over the registry (`HudCallbacks` is the existing seam).

**Parsing.** `plate` and `unrest` join `TilesScene` in `src/sim/scene.ts` as
strictly-parsed typed fields, matching the existing layer discipline.

## 6. Honesty constraints

Each of these follows from existing precedent, not taste:

1. **`moisture` is labeled "moisture," never "rainfall."** The Isotherm spec
   is explicit that the layer is a dimensionless index and that a physical
   mm/yr calibration would be invented precision; the promotion path is
   registry row CLIM-precip-units and would arrive as a *new* field. A
   "rainfall" label would launder invented precision into the UI.
2. **Ice gates to the natural lens.** It blends into base vertex colors, so
   leaving it active would corrupt a data colormap — and a data mode should
   not carry decorative ice regardless.
3. **Every lens states what it exaggerates or invents** (orrery#3's caption
   discipline, following `ICE_CAPTION` / `GROUND_CAPTION` in `main.ts`).
   Colormaps are presentation-only under decision 0022, the same footing as
   the ice overlay: the sim has no cryosphere and no palette.
4. **`plate` colors carry separation, not identity.** Plate ids are arbitrary
   per-world labels (`Vec<u32>`, type-audit `bare-ok(index: plate)`) with no
   cross-world meaning and no ordering. See §7.1 — the plate count makes even
   categorical *identity* coloring untenable, and the resolution is the
   cartographic one.

## 7. Colormaps (validated — `dataviz` skill, computed not eyeballed)

Every palette below was validated with the skill's own validator against the
orrery's actual background (`#05070f`), not chosen by eye. Two binding
constraints shaped the results:

- `temperature` **diverges about 0 °C** — the freezing point is the
  meaningful midpoint, and the one the ice overlay already keys on.
- Every lens must survive the terminator. The globe is *lit*: vertex colors
  are multiplied by the directional light, so a dark ramp goes black on the
  night side. Light bases keep headroom — which is why temperature takes the
  palette's **light** neutral midpoint rather than its dark-mode one.

| Lens | Job | Ramp |
|---|---|---|
| `natural` | — | unchanged (existing `elevationColor` / `biomeColorForName`) |
| `topographic` | sequential | the existing `elevationColor` hypsometric ramp, applied to land and sea alike. A cartographic convention already shipped and shared with the atlas raster; replacing it with a generic one-hue ramp would regress it for no gain. |
| `temperature` | diverging | `#2a78d6` ← `#f0efec` → `#e34948` over [−40, 0, +40] °C, clamped. The palette's exact diverging pair and neutral midpoint (never a hue at the midpoint). |
| `moisture` | sequential | blue `#cde2fb` → `#0d366b` over [0, 1] — the default sequential hue. |
| `unrest` | sequential | aqua `#d4f0e4` → `#0a4a33` over [0, 1]. A distinct hue from moisture so switching lenses is recognizable; the two are never concurrent, so the one-hue rule is not in tension. |
| `plate` | categorical | six slots + boundary ink — see §7.1. |

### 7.1 The plate lens — why adjacency coloring

Seed 42 has **16 plates**; the validated palette has 8 slots. Per-plate
identity coloring is therefore impossible, and the skill forbids generating a
9th hue or cycling. Cycling would also *lie*: two adjacent plates drawing the
same color read as one plate.

The resolution is the standard cartographic one. Plate ids are arbitrary
labels; what is physical is **where the boundaries are**. So color's job here
is separation, not identity:

1. Build the plate adjacency graph from the tile lattice (4-neighbour, with
   longitude wraparound).
2. Greedy-color it in **degeneracy (smallest-last) order**, ties broken by
   plate id for determinism. A planar graph has degeneracy ≤ 5, so this is
   theorem-backed to need **≤ 6 colors** — no cycling fallback can arise.
3. Ink plate-boundary tiles (any 4-neighbour with a different plate id).

**The validator's decisive finding:** on a *map*, any two regions can share a
border, so the correct test is the worst pair over **all** pairs — not the
palette-order-adjacent pairs the validator checks by default. Computing all 28
pairs of the dark column found **blue ↔ violet at ΔE 2.5** under protanopia
(effectively identical) and aqua ↔ magenta at 4.7. Both are perfectly safe in
the palette's canonical slot order and catastrophic on a choropleth.

Excluding violet and magenta gives the six slots — blue `#3987e5`, aqua
`#199e70`, yellow `#c98500`, green `#008300`, red `#e66767`, orange `#d95926`
— whose worst pair is 9.7 (aqua ↔ red). That sits in the 8–12 floor band,
which is legal **only** with secondary encoding; the boundary ink of step 3
supplies it, and is the layer's real information regardless.

(The all-pairs-≥12 maximum is exactly 4 colors — a pleasing echo of the
four-color theorem, but too tight for a greedy coloring to guarantee.)

## 8. Testing

Follows the repo's vitest discipline:

- **Per-lens unit tests:** `colorAt` at known layer values; endpoints and
  midpoints of each colormap; `plate` ids map to stable distinct colors.
- **Registry test:** every registered lens has a caption and a legend, and
  `dependsOnDay` is true iff `colorAt` varies with `day` (a property test
  over the roster — this catches a future lens forgetting the flag).
- **`natural` regression:** the `natural` lens reproduces today's colors
  exactly, tile for tile, over the seed-42 catalog fixture. This is the
  guard that the refactor is behavior-preserving.
- **Ice gating:** ice recolor is inactive under a data lens.
- **Parsing:** `plate`/`unrest` strict-parse, matching existing scene tests.

## 9. Non-goals

- **Pixel-art and drawn-map styles** (orrery#3's other two thirds) — this
  campaign is the data-modes third only.
- **Topographic contours** — crisp isolines need fragment-shader
  derivatives; that is orrery#2's pipeline to build.
- **The texture/shader color re-architecture** orrery#3 muses about. It is
  exactly the pipeline the deferred orrery#2 CDLOD renderer will rework;
  doing it now would pick a fight with The Region's own follow-on. Per-vertex
  recolor through the existing `buildFaceGeometry` path is sufficient for
  every lens in §4.
- **Population and transport lenses** — hornvale#5's trailing half; no
  producer layers exist yet. §3's registry is the seam they will land on.
- **Any producer-side change.** Zero hornvale commits; no catalog version
  bump.

## 10. Coexistence with The Region

The Region (in flight) claims, in this repo: `src/sim/scene.ts` (a
`RegionScene` interface), `src/sim/climate.ts` (regional evaluator arrays),
`src/sim/catalog.ts` (`CATALOG_VERSION` → `world-wasm-v3`),
`public/hornvale_world.wasm`, and a new single-patch view module.

The Lens touches `src/views/*`, `src/ui/hud.ts`, `src/main.ts`, and — the one
overlap — `src/sim/scene.ts`, where it adds two parsed fields while The
Region adds an interface. Additive and mechanical.

The Lens needs **no catalog bump**, so it cannot race The Region's v3 pin.
Whichever lands second absorbs the other; if The Region lands first, The Lens
absorbs at its next stage boundary per the standing absorption rule.

## 11. Flagged for G3

1. **Roadmap divergence (the reason this is a hard stop).** The Isotherm
   spec's §2 roadmap puts **The Moons (hv#4)** next, then orrery#4, then
   orrery#5/#6 as the designated parallel lane. This campaign skips The Moons
   and pulls orrery#3 forward past both. Rationale: The Moons is the one lane
   that genuinely collides with The Region (`windows/scene`,
   `clients/world-wasm`, `cli/src/main.rs`, and a v4-vs-v3 catalog race), and
   the §1 rendering debt is a payoff the roadmap did not account for because
   it was invisible until the layer lifecycle was enumerated. The Moons is
   deferred, not dropped, and unblocks cleanly once The Region lands.
2. **No epoch, no save-format, no determinism-contract implications.**
   Client-side presentation only (decision 0022); no producer change; no
   census exposure; no AWS spend.
3. **The `natural` refactor touches shipped visuals.** §8's tile-for-tile
   regression over the seed-42 fixture is the guard; if it cannot be made to
   pass exactly, that is a finding worth surfacing rather than re-baselining.
