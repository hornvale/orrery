# orrery

The planetarium: a glamorous 3D client for [Hornvale](https://github.com/hornvale/hornvale)
worlds — live at <https://hornvale.github.io/orrery/>. Enter a seed; genesis
runs in your browser via the world-wasm catalog; the system and the globe
render in three.js. (Formerly `goldengrove`; renamed 2026-07-14 — Pages
URLs do not redirect, so the old `/goldengrove/` path is gone.)

Lineage: the three.js views descend from bitterbridge/goldengrove; the
ephemeris/scene modules from hornvale's retired in-book orrery client.
Presentation here is deliberately non-deterministic (hornvale decision
0022: the sim emits data, clients render). MIT.

## Lenses

The globe view has six selectable lenses plus one overlay (the HUD's lens
panel, bottom-left). Each owns its own colormap, legend, and caption —
adding a lens costs one file (`src/views/lens.ts`), never a HUD edit.

| Lens | Caption |
| --- | --- |
| `natural` | ocean shaded by depth, land by biome — a rendering choice, not a photograph: the sim ships numbers, not colors. |
| `topographic` | elevation through the atlas hypsometric ramp, relative to sea level; colors are a cartographic convention, not the ground's actual hue. |
| `temperature` | surface temperature on the shown day, diverging about freezing and clamped at ±40 °C; the seasonal curve is the producer's own evaluator, not a client invention. The one *living* lens — it repaints as the clock runs, the rest are static. |
| `moisture` | the climate model's dimensionless moisture index (0-1) — not rainfall: no mm/yr calibration exists, and inventing one would be invented precision. |
| `unrest` | tectonic unrest, dimensionless (0-1) — highest along young convergent boundaries, near zero in old interiors; a static present-day snapshot read off plate geometry, not a simulation of seismicity. |
| `plates` | tectonic plates, colored so neighbours differ — a map coloring, not identities: a plate's id is an arbitrary label and carries no order or meaning across worlds. |
| *winds* (overlay) | prevailing-wind bands, arrowed by latitude — composes with whichever lens is active; disabled on a tidally locked world (no circulation bands). |

Every colormap here is presentation-only (hornvale decision 0022: the sim
emits data, clients render) — the layers themselves (elevation, biome,
temperature, moisture, unrest, plate id, circulation bands) are the
producer's.

## Dev

The catalog (`public/hornvale_world.wasm`) is never committed (decision
0052's regime) — CI fetches the release build, and locally you build it
yourself:

```bash
npm run wasm:local   # copies the release wasm into public/
npm test
npm run build
```

`wasm:local` copies from the sibling hornvale checkout (`../hornvale`);
build the catalog there first with `make wasm-world`.

Release consumption: CI and the live Pages deploy pin the catalog to
hornvale release `world-wasm-v3` (`npm run wasm:release`).
