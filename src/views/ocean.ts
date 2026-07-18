/** The ocean layer: a smooth, translucent sea-level sphere over the
 * displaced seafloor (spec: docs/superpowers/specs/2026-07-15-watery-oceans-design.md).
 * Same split as the other views: pure grading/radius math (unit-tested
 * directly), then the three.js builder that consumes it. */
import * as THREE from 'three';
import type { TilesScene } from '../sim/scene';
import { REFERENCE_RADIUS_M, sampleTile } from './worldMesh';
import { TILE_QUADS, tileGrid } from './cubeSphere';
import { fnv1a32, mulberry32 } from '../util/prng';

/** Depth (m below sea level) at which water reaches full darkness/opacity. */
export const DEEP_FULL_M = 3000;
/** Water alpha over the shallowest ocean (seafloor clearly visible). */
export const SHALLOW_ALPHA = 0.35;
/** Water alpha at DEEP_FULL_M and beyond (nearly opaque). */
export const DEEP_ALPHA = 0.92;
/** Shallow-water tint (0-1 channels) — a tuning knob, not a contract. */
export const SHALLOW_COLOR: [number, number, number] = [0.55, 0.8, 0.85];
/** Deep-water tint (0-1 channels) — a tuning knob, not a contract. */
export const DEEP_COLOR: [number, number, number] = [0.02, 0.15, 0.3];

/** The sea sphere's radius: exactly where `buildFaceGeometry` puts sea level
 * for this `reliefScale` (sea_level_m is datum-relative and negative in
 * practice, so this sits below the undisplaced radius). */
export function seaLevelRadius(tiles: TilesScene, radius: number, reliefScale: number): number {
  return radius * (1 + (reliefScale * tiles.sea_level_m) / REFERENCE_RADIUS_M);
}

/** Depth-graded water: pale, translucent aqua over the shallows smoothing to
 * near-opaque dark blue by DEEP_FULL_M. Callers gate land to alpha 0 with the
 * tile's own `ocean` flag — depth alone can't tell coastal land (elevation at
 * exactly sea level) from zero-depth sea. */
export function waterColorAlpha(depthM: number): { r: number; g: number; b: number; a: number } {
  const t = Math.min(1, Math.max(0, depthM / DEEP_FULL_M));
  const s = t * t * (3 - 2 * t); // smoothstep
  const lerp = (from: number, to: number) => from + (to - from) * s;
  return {
    r: lerp(SHALLOW_COLOR[0], DEEP_COLOR[0]),
    g: lerp(SHALLOW_COLOR[1], DEEP_COLOR[1]),
    b: lerp(SHALLOW_COLOR[2], DEEP_COLOR[2]),
    a: lerp(SHALLOW_ALPHA, DEEP_ALPHA),
  };
}

/** One cube face of the sea: a smooth sphere at `seaLevelRadius`, RGBA
 * vertex colors carrying the depth grading (alpha 0 over land, so continents
 * punch through with a soft coastline). Normals are the unit position
 * directions — exact for a sphere, and identical across face edges by
 * construction, so no seam stitching is needed. Returns null when the whole
 * face is land (no mesh at all beats an invisible one). */
export function buildOceanGeometry(
  tiles: TilesScene,
  face: number,
  radius: number,
  reliefScale: number,
): THREE.BufferGeometry | null {
  const grid = tileGrid({ face, level: 0, ix: 0, iy: 0 });
  const n = TILE_QUADS + 1;
  const r = seaLevelRadius(tiles, radius, reliefScale);
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 4);
  let hasOcean = false;
  for (let i = 0; i < n * n; i++) {
    const ux = grid.units[3 * i]!;
    const uy = grid.units[3 * i + 1]!;
    const uz = grid.units[3 * i + 2]!;
    positions[3 * i] = ux * r;
    positions[3 * i + 1] = uy * r;
    positions[3 * i + 2] = uz * r;
    normals[3 * i] = ux;
    normals[3 * i + 1] = uy;
    normals[3 * i + 2] = uz;
    const lat = grid.lats[i]!;
    const lon = grid.lons[i]!;
    const ocean = sampleTile(tiles, lat, lon, 'ocean');
    const water = waterColorAlpha(tiles.sea_level_m - sampleTile(tiles, lat, lon, 'elevation_m'));
    colors[4 * i] = water.r;
    colors[4 * i + 1] = water.g;
    colors[4 * i + 2] = water.b;
    colors[4 * i + 3] = ocean ? water.a : 0;
    if (ocean) hasOcean = true;
  }
  if (!hasOcean) return null;
  // Per-face grid UVs (not equirect lat/lon): each face's own row/col
  // parameterization, continuous across the whole face. Equirect UVs were
  // tried first and rejected in review — atan2's branch cut tears a
  // full-range UV jump across the ±180° antimeridian on face 1, and warps
  // globally on the polar faces 4/5. The tradeoff here is that the wave
  // pattern doesn't line up exactly across cube-face edges — and the drift
  // direction mirrors between faces (their u/v axes differ) — but at this
  // normalScale (0.15) both mismatches are imperceptible.
  const uvs = new Float32Array(n * n * 2);
  for (let i = 0; i < n * n; i++) {
    const row = Math.floor(i / n);
    const col = i % n;
    uvs[2 * i] = col / TILE_QUADS;
    uvs[2 * i + 1] = row / TILE_QUADS;
  }
  const indices: number[] = [];
  for (let row = 0; row < TILE_QUADS; row++) {
    for (let col = 0; col < TILE_QUADS; col++) {
      const i00 = row * n + col;
      const i10 = row * n + col + 1;
      const i01 = (row + 1) * n + col;
      const i11 = (row + 1) * n + col + 1;
      // Same CCW winding as worldMesh's buildFaceGeometry — outward-facing
      // on every face without a per-face special case.
      indices.push(i00, i10, i11, i00, i11, i01);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/** UV drift of the wave normal map per sim day. Two unequal rates whose
 * joint period (100 days — both are hundredths) far exceeds any viewing
 * session; slow enough that 1 day/s (the globe clock's cap) shimmers rather
 * than strobes, fast enough that 1 hr/s visibly lives. */
const WAVE_DRIFT_PER_DAY = { x: 0.37, y: 0.13 };

/** How strongly the wave normals dent the lighting — subtle: the sea should
 * shimmer, not boil. */
const WAVE_NORMAL_SCALE = 0.15;

/** Repeats of the (tileable) wave texture around the sphere. */
const WAVE_REPEAT = 6;

/** Ocean material roughness with the sun-glint on: low enough for a sharp
 * specular highlight where the star reflects. */
const GLINT_ROUGHNESS = 0.2;
/** Ocean material roughness with the glint off: near-matte, so the sea reads
 * as flat depth-graded water with no moving highlight. */
const MATTE_ROUGHNESS = 0.95;

const frac = (v: number) => v - Math.floor(v);

/** The wave normal map's UV offset at `day` — pure and wrapped to [0,1), so
 * the same day always shows the same sea (spec: sim-clock determinism). */
export function waveOffset(day: number): { x: number; y: number } {
  return { x: frac(day * WAVE_DRIFT_PER_DAY.x), y: frac(day * WAVE_DRIFT_PER_DAY.y) };
}

/** A small tileable wave normal map, generated deterministically on a canvas
 * (the deploy CSP forbids fetched assets). Height field = a seeded sum of
 * integer-frequency sines (integer wave numbers keep it tileable); normals
 * come from its finite differences. Returns null where no 2D context exists
 * (happy-dom) — the ocean then simply has no wave detail, matching how
 * buildLabelSprite degrades. */
function buildWaveNormalMap(): THREE.CanvasTexture | null {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rand = mulberry32(fnv1a32('goldengrove/ocean/waves'));
  // A fixed handful of tileable plane waves: integer frequencies, random
  // phase and direction mix.
  const waves = Array.from({ length: 6 }, () => ({
    fx: 1 + Math.floor(rand() * 4),
    fy: 1 + Math.floor(rand() * 4),
    phase: rand() * Math.PI * 2,
    amp: 0.5 + rand(),
  }));
  const height = (x: number, y: number) =>
    waves.reduce(
      (h, w) => h + w.amp * Math.sin(((x * w.fx + y * w.fy) / size) * Math.PI * 2 + w.phase),
      0,
    );
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Central differences with wrap: tileable normals from a tileable field.
      const dx = height((x + 1) % size, y) - height((x - 1 + size) % size, y);
      const dy = height(x, (y + 1) % size) - height(x, (y - 1 + size) % size);
      const inv = 1 / Math.hypot(dx, dy, 2);
      const i = 4 * (y * size + x);
      img.data[i] = Math.round(((-dx * inv) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round(((-dy * inv) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(((2 * inv) * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(WAVE_REPEAT, WAVE_REPEAT);
  return texture;
}

/** The ocean's public surface: a mountable node plus the two drivers the
 * globe view forwards (relief toggle, per-frame day). */
export interface OceanView {
  object3d: THREE.Object3D;
  /** Swap to 1× (true) or schematic (false) sea-level radius — mirrors the
   * terrain's lazily-built second geometry set. */
  setTrueRelief(on: boolean): void;
  /** Show or hide the drifting wave pattern (the normal map). Off leaves a
   * smooth, still sea surface — the depth grading stays. */
  setWaves(on: boolean): void;
  /** Turn the sun-glint (specular highlight) on or off. Off makes the sea
   * near-matte. Independent of the waves toggle. */
  setGlint(on: boolean): void;
  /** Per-frame driver. Stage 1: reserved (no-op). Stage 2 drifts the wave
   * normal map deterministically from the sim day. */
  update(day: number): void;
}

/** Build the water layer for a globe of `radius` whose schematic relief
 * exaggeration is `schematicReliefScale` (the globe passes its own
 * RELIEF_EXAGGERATION; true relief is always 1×). */
export function createOcean(
  tiles: TilesScene,
  radius: number,
  schematicReliefScale: number,
): OceanView {
  const root = new THREE.Object3D();
  root.name = 'ocean';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    roughness: GLINT_ROUGHNESS,
    metalness: 0,
    depthWrite: false,
  });
  const waves = buildWaveNormalMap();
  if (waves) {
    material.normalMap = waves;
    material.normalScale = new THREE.Vector2(WAVE_NORMAL_SCALE, WAVE_NORMAL_SCALE);
  }
  // Only ocean-bearing faces get meshes; remember which, so the true-relief
  // set (lazily built) pairs up by face index.
  const faceMeshes = new Map<number, THREE.Mesh>();
  for (let face = 0; face < 6; face++) {
    const geom = buildOceanGeometry(tiles, face, radius, schematicReliefScale);
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = `ocean-face-${face}`;
    // Clicks pass through the water to the world beneath.
    mesh.raycast = () => {};
    root.add(mesh);
    faceMeshes.set(face, mesh);
  }
  const schematicGeoms = new Map([...faceMeshes].map(([f, m]) => [f, m.geometry]));
  let trueGeoms: Map<number, THREE.BufferGeometry> | null = null;
  function setTrueRelief(on: boolean): void {
    if (on && trueGeoms === null) {
      trueGeoms = new Map(
        [...faceMeshes.keys()].map((f) => [f, buildOceanGeometry(tiles, f, radius, 1)!]),
      );
    }
    for (const [f, mesh] of faceMeshes) {
      mesh.geometry = (on ? trueGeoms! : schematicGeoms).get(f)!;
    }
  }
  function setWaves(on: boolean): void {
    // Adding/removing a map changes the shader, so flag a recompile. `waves`
    // is null in a headless DOM — then this is a no-op either way.
    material.normalMap = on ? waves : null;
    material.needsUpdate = true;
  }
  function setGlint(on: boolean): void {
    material.roughness = on ? GLINT_ROUGHNESS : MATTE_ROUGHNESS;
  }
  function update(day: number): void {
    if (!material.normalMap) return; // headless DOM (or waves off): nothing to drift
    const { x, y } = waveOffset(day);
    material.normalMap.offset.set(x, y);
  }
  return { object3d: root, setTrueRelief, setWaves, setGlint, update };
}
