# goldengrove

The planetarium: a glamorous 3D client for [Hornvale](https://github.com/hornvale/hornvale)
worlds. Enter a seed; genesis runs in your browser via the world-wasm
catalog; the system and the globe render in three.js.

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

`wasm:local` currently builds from the campaign worktree
(`hornvale/.claude/worktrees/goldengrove/clients/world-wasm`), since the
sibling `../hornvale` checkout layout doesn't exist yet.
# TODO(campaign-close): retarget to ../hornvale once the branch merges

Release consumption: CI and the live Pages deploy pin the catalog to
hornvale release `world-wasm-v1` (`npm run wasm:release`).
