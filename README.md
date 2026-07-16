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
