# Watery Oceans — Design

**Ticket:** hornvale/orrery#1
**Date:** 2026-07-15
**Status:** Approved

## Problem

Oceans render as the displaced seafloor, vertex-colored by depth, sharing the
land's rough matte material. Legible, but it reads as painted stone: no glint,
no translucency, no motion.

## Decisions (from brainstorm)

1. **Scope:** the full stack — surface, glint, motion — designed together,
   built in stages, glint first.
2. **Bathymetry:** depth-graded. Shallows translucent (seafloor clearly
   visible, pale aqua); deep ocean nearly opaque dark blue. The depth-band
   seafloor coloring stays underneath.
3. **Wave clock:** the sim day drives motion. Deterministic (same day = same
   sea), frozen when paused, amplitude tuned so 1 day/s does not strobe.
4. **Architecture:** a second, smooth sea-level sphere over the untouched
   seafloor (approach A). Rejected: patching the terrain material's shader in
   place — the glint would ride the 60×-exaggerated trench walls, fixing that
   clamps away the see-through shallows, and `onBeforeCompile` is the most
   upgrade-fragile tool available.

This is also *more* honest than the current render: real seas are flat.
Trenches show as darkening water, not visible pits; the 60× relief lie stays
confined to land and to the seafloor seen through the water.

## Architecture

One new module `src/views/ocean.ts`, following the house split (pure math,
unit-tested directly + a three.js builder consuming it).

### Pure surface

- `seaLevelRadius(tiles, radius, reliefScale)` → `radius * (1 + reliefScale *
  tiles.sea_level_m / REFERENCE_RADIUS_M)`. Exactly where `buildFaceGeometry`
  puts sea level in each relief mode. (`sea_level_m` is datum-relative and
  negative in practice; see the memory note on scene-data quirks.)
- `waterColorAlpha(depthM)` → `{ r, g, b, a }`, 0–1 channels. Depth is
  `sea_level_m − elevation_m` at an ocean tile. Grading: depth 0 → pale aqua,
  low alpha (~0.35); smoothstep to near-opaque dark blue (~0.92) by
  `DEEP_FULL_M = 3000`; monotonic in between. Land → alpha 0 (any color).
  Starting colors (tuning knobs, not contracts): shallow ≈ rgb(0.55, 0.80,
  0.85), deep ≈ rgb(0.02, 0.15, 0.30).

### Geometry builder

- `buildOceanGeometry(tiles, face, radius, reliefScale)` → a smooth cube-sphere
  face at `seaLevelRadius`, built on the same `tileGrid` addressing as the
  terrain so coastal alpha edges line up with the terrain's tile borders.
  - **RGBA vertex colors** (`color` attribute, itemSize 4) from
    `waterColorAlpha` of the tile sampled at each vertex (`sampleTile`,
    `elevation_m` + `ocean`).
  - **Analytic normals**: a sphere's normal is its unit position — set
    directly, no `computeVertexNormals`, no seam stitching needed.
  - Faces whose sampled vertices are all land are skipped (no mesh).

### View integration

- `createOcean(tiles)` → `{ object3d, setTrueRelief(on), update(day) }`.
- Mounted inside the globe view's `spinGroup` (rotates with the ground;
  motion stays deterministic relative to coastlines).
- `createGlobeView` owns the ocean: constructs it, forwards `setTrueRelief`
  and `update(day)` calls it already receives.
- Each ocean mesh's `raycast` is a no-op so picking passes through to the
  seafloor/world.

## Material and light

One `MeshStandardMaterial`:

```
vertexColors: true   // RGBA — alpha carries the depth grading
transparent:  true
roughness:    ~0.2   // tuning knob; the glint
metalness:    0
depthWrite:   false  // transparent pass; no acne where surfaces near-touch
```

- The existing terminator `DirectionalLight` produces the sun glint; no new
  lights. Land stays matte because the water is alpha-0 there — standard
  alpha blending multiplies the specular contribution away, and coastlines
  fade softly for free.
- Night-side water falls to shader darkness like everything else. The honest
  terminator is untouched, and no caption change is needed: a flat sea is not
  a lie.

## Relief modes

- Schematic (60×): sea sphere at ~0.976 × globe radius; displaced seafloor
  visible through shallow water.
- True (1×): second geometry set, built lazily on first toggle (mirrors the
  terrain's pattern); surfaces nearly coincide but `depthWrite: false` in the
  transparent pass keeps it artifact-free.
- `setTrueRelief` swaps geometry sets, same as the terrain meshes.

## Staging

1. **Surface + glint** (this spec's implementation target): sea-level sphere,
   depth-graded RGBA translucency, low-roughness glint. Static. Ships alone.
2. **Motion**: a small tiling normal map, generated on a canvas at build time
   (seeded, deterministic, no external assets — CSP forbids them), assigned to
   the material with modest `normalScale`; `update(day)` drifts
   `normalMap.offset` as a function of the sim day. Same day = same sea.
3. **Later, out of scope**: fresnel rim brightening (`onBeforeCompile`),
   deliberately deferred.

## Out of scope

- The system view's world sphere: its seafloor sits exactly at sea-level
  radius (reliefScale 0), so an ocean layer there needs an epsilon-lift
  design of its own. Follow-up.
- Wave geometry (gerstner etc.), foam, specular env maps.

## Error handling

No new error surfaces: the module consumes an already-validated `TilesScene`.
Degenerate documents (no ocean tiles at all) produce no ocean meshes and
nothing else changes.

## Testing

- **Pure:** `seaLevelRadius` in both relief modes; `waterColorAlpha`
  endpoints (0 m, ≥3000 m), monotonic alpha in depth, land → alpha 0.
- **Geometry:** every vertex at sea-level radius; `color` itemSize 4; alpha 0
  at land vertices and > 0 at ocean vertices; all-land face skipped; normals
  equal unit position directions.
- **View:** globe graph contains ocean meshes; their `raycast` is a no-op;
  `setTrueRelief(true)` moves vertices to the 1× radius; (stage 2)
  `update(day)` sets a normal-map offset that is a pure function of day.
- **Visual:** in-browser screenshots against seed 42 — glint patch on the
  day-side sea, matte land, readable shallows, dark trenches, clean 1× toggle.
