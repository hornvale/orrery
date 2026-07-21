/** The symbol layer: a `THREE.Group` of sprites (mountain peaks, forest
 * tree-clusters, ocean wave-marks) placed on the globe, selected per zoom
 * rung against the salience budget (`./budget`), culled to the near
 * hemisphere (`../globe`'s `onNearSide`). This is the visible payoff of The
 * Cartographer. Settlements are NOT drawn here — the globe's own always-on
 * markers (`../globe`'s `buildSiteMarker`) already cover them, so this layer
 * stays peaks+forests+waves only to avoid doubling up.
 *
 * Extraction (`./extract`) runs once at build time — the tile data doesn't
 * change under a mounted layer, only the camera does — so `update` only
 * rebuilds children on a rung boundary crossing and otherwise just re-culls.
 */
import * as THREE from 'three';
import type { TilesScene } from '../../sim/scene';
import { GLOBE_RADIUS, latLonToUnit, onNearSide } from '../globe';
import type { Peak, ForestRegion } from './extract';
import { extractForests, extractPeaks } from './extract';
import type { Rung } from './budget';
import { RUNG_BUDGETS, selectByBudget } from './budget';

/** Deterministic [0,1) from an integer — used for the forest-scatter jitter
 * so tree placement never shimmers between identical updates (no
 * `Math.random` anywhere in this module). */
export function hash01(i: number): number {
  let x = (i | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** How far above the globe surface (as a fraction of `GLOBE_RADIUS`, matching
 * `../globe`'s `MARKER_CLEARANCE` idiom) a symbol sprite floats. */
const SYMBOL_CLEARANCE = 1.01;

/** Peak sprite scale bounds, in units of `GLOBE_RADIUS` — a tall peak reads
 * bigger than a modest one, clamped so an extreme elevation never dwarfs the
 * globe. Doubled from the original (0.02 / 0.08) — the visual pass found
 * peaks too faint to read at far/mid zoom; the elevation-proportional term
 * is unchanged. */
const PEAK_SCALE_MIN = 0.04;
const PEAK_SCALE_ELEVATION_FACTOR = 0.00001;
const PEAK_SCALE_MAX = 0.16;

/** Tree sprite scale, in units of `GLOBE_RADIUS`. */
const TREE_SCALE = 0.018;

/** Wave-mark sprite scale, in units of `GLOBE_RADIUS` — modest and fixed
 * (unlike peaks, waves don't carry a magnitude to scale against). */
const WAVE_SCALE = 0.02;

/** Wave marks float closer to the ocean surface than the
 * `SYMBOL_CLEARANCE`-lofted peak/tree sprites — they're a texture accent, not
 * a landmark. */
const WAVE_CLEARANCE = 1.004;

/** Max tree sprites drawn per forest region (also clamps the log2(area)
 * placement count below). */
const MAX_TREES_PER_FOREST = 8;

/** Jitter radius (degrees) for tree placement around a forest's centroid. */
const TREE_JITTER_DEG = 1.5;

/** Build a small offscreen-canvas texture for a symbol class, falling back to
 * a flat-colour material when no 2D context is available (jsdom — the unit
 * tests here run headless with no canvas 2D renderer, same guard as
 * `../globe`'s `buildLabelSprite`). */
function buildSymbolMaterial(draw: (ctx: CanvasRenderingContext2D, size: number) => void, fallbackColor: number): THREE.SpriteMaterial {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.SpriteMaterial({ color: fallbackColor });
  }
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  return new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
}

function buildPeakMaterial(): THREE.SpriteMaterial {
  return buildSymbolMaterial((ctx, size) => {
    // Body: dark slate triangle — bolder than the original mid-grey so it
    // reads clearly against land (visual pass: peaks too faint to read).
    ctx.fillStyle = 'rgb(70,74,86)';
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.12);
    ctx.lineTo(size * 0.88, size * 0.88);
    ctx.lineTo(size * 0.12, size * 0.88);
    ctx.closePath();
    ctx.fill();
    // Subtle darker outline for edge contrast.
    ctx.strokeStyle = 'rgb(34,36,44)';
    ctx.lineWidth = size * 0.04;
    ctx.stroke();
    // Pale snow cap at the apex.
    ctx.fillStyle = 'rgb(242,245,248)';
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.12);
    ctx.lineTo(size * 0.63, size * 0.34);
    ctx.lineTo(size * 0.5, size * 0.4);
    ctx.lineTo(size * 0.37, size * 0.34);
    ctx.closePath();
    ctx.fill();
  }, 0x464a56);
}

function buildTreeMaterial(): THREE.SpriteMaterial {
  return buildSymbolMaterial((ctx, size) => {
    ctx.fillStyle = '#3f7d3f';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }, 0x3f7d3f);
}

/** Stylized `~~` wave-mark texture for ocean tiles — two short wavy strokes
 * in light cyan, matching the pixel-art-RPG convention for open sea. */
function buildWaveMaterial(): THREE.SpriteMaterial {
  return buildSymbolMaterial((ctx, size) => {
    ctx.strokeStyle = 'rgba(200,235,245,0.9)';
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';
    const drawWave = (yBase: number): void => {
      ctx.beginPath();
      ctx.moveTo(size * 0.1, yBase);
      ctx.quadraticCurveTo(size * 0.3, yBase - size * 0.08, size * 0.5, yBase);
      ctx.quadraticCurveTo(size * 0.7, yBase + size * 0.08, size * 0.9, yBase);
      ctx.stroke();
    };
    drawWave(size * 0.4);
    drawWave(size * 0.62);
  }, 0xc8ebf5);
}

/** A symbol's class, tagged onto its sprite's `userData.kind` so tests (and
 * any future per-kind styling) can select without re-deriving it from the
 * material. */
export type SymbolKind = 'peak' | 'tree' | 'wave';

/** A built sprite tagged with the unit "up" direction it was placed at, so
 * the near-side cull (`onNearSide`) doesn't need to re-derive it from
 * position/GLOBE_RADIUS each frame, plus its symbol kind. `clearance`
 * defaults to the peak/tree float height; wave marks pass `WAVE_CLEARANCE`
 * to sit closer to the ocean surface. */
function placedSprite(
  material: THREE.SpriteMaterial,
  lat: number,
  lon: number,
  scale: number,
  kind: SymbolKind,
  clearance: number = SYMBOL_CLEARANCE,
): THREE.Sprite {
  const sprite = new THREE.Sprite(material);
  const up = latLonToUnit(lat, lon);
  sprite.position.copy(up).multiplyScalar(GLOBE_RADIUS * clearance);
  sprite.scale.set(GLOBE_RADIUS * scale, GLOBE_RADIUS * scale, 1);
  sprite.userData.up = up;
  sprite.userData.kind = kind;
  return sprite;
}

/** The symbol layer's public surface: a mountable group plus the per-frame
 * driver the globe view calls with the current rung and camera position. */
export interface SymbolLayer {
  /** The layer's root node — mount this once into the globe's spinning
   * group so symbols turn with the planet. */
  group: THREE.Group;
  /** Rebuilds the child sprite set on a rung boundary crossing (a no-op
   * rebuild otherwise), then re-culls every child to the near hemisphere
   * against `camWorld`. */
  update(rung: Rung, camWorld: THREE.Vector3): void;
  /** Removes every child and disposes the three shared materials/textures. */
  dispose(): void;
}

/** Build the symbol layer for `tiles`: extracts peaks/forests once, builds
 * the two shared sprite materials once, and returns a layer whose `update`
 * rebuilds the (budget-bounded, so cheap) child set only when the rung
 * actually changes. */
export function buildSymbolLayer(tiles: TilesScene): SymbolLayer {
  const peaks: Peak[] = extractPeaks(tiles);
  const forests: ForestRegion[] = extractForests(tiles);

  const peakMaterial = buildPeakMaterial();
  const treeMaterial = buildTreeMaterial();
  const waveMaterial = buildWaveMaterial();

  const group = new THREE.Group();
  group.name = 'symbol-layer';

  let lastRung: Rung | null = null;

  function rebuild(rung: Rung): void {
    while (group.children.length > 0) group.remove(group.children[0]!);
    const b = RUNG_BUDGETS[rung];

    const chosenPeaks = selectByBudget(peaks.filter((p) => p.elevationM >= b.peakMinElevationM), b.peaks);
    for (const p of chosenPeaks) {
      const scale = Math.min(PEAK_SCALE_MAX, PEAK_SCALE_MIN + PEAK_SCALE_ELEVATION_FACTOR * p.elevationM);
      group.add(placedSprite(peakMaterial, p.lat, p.lon, scale, 'peak'));
    }

    const chosenForests = selectByBudget(forests.filter((f) => f.area >= b.forestMinArea), b.forests);
    for (const f of chosenForests) {
      const n = Math.min(MAX_TREES_PER_FOREST, Math.max(1, Math.round(Math.log2(f.area + 1))));
      for (let k = 0; k < n; k++) {
        const hLat = hash01(f.tileIndex * 8 + k);
        const hLon = hash01(f.tileIndex * 8 + k + 4);
        const lat = f.lat + (hLat * 2 - 1) * TREE_JITTER_DEG;
        const lon = f.lon + (hLon * 2 - 1) * TREE_JITTER_DEG;
        group.add(placedSprite(treeMaterial, lat, lon, TREE_SCALE, 'tree'));
      }
    }

    // Wave marks: sparse cartographic sea-texture, gated by the rung's
    // stride/cap. Deterministic grid walk — no jitter, no Math.random.
    const { width, height } = tiles;
    let waveCount = 0;
    waveScan: for (let y = 0; y < height; y += b.waveStride) {
      for (let x = 0; x < width; x += b.waveStride) {
        if (waveCount >= b.waves) break waveScan;
        if (!tiles.ocean[y * width + x]) continue;
        const lat = 90 - ((y + 0.5) / height) * 180;
        const lon = -180 + ((x + 0.5) / width) * 360;
        group.add(placedSprite(waveMaterial, lat, lon, WAVE_SCALE, 'wave', WAVE_CLEARANCE));
        waveCount++;
      }
    }
  }

  function update(rung: Rung, camWorld: THREE.Vector3): void {
    if (rung !== lastRung) {
      rebuild(rung);
      lastRung = rung;
    }
    for (const child of group.children) {
      const up = child.userData.up as THREE.Vector3 | undefined;
      if (up) child.visible = onNearSide(up, camWorld, GLOBE_RADIUS);
    }
  }

  function dispose(): void {
    while (group.children.length > 0) group.remove(group.children[0]!);
    for (const material of [peakMaterial, treeMaterial, waveMaterial]) {
      material.map?.dispose();
      material.dispose();
    }
  }

  return { group, update, dispose };
}
