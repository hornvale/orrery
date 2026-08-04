/** The 3D dither texture behind Surface-Stable Fractal Dithering
 * (runevision.com/tech/dither3d, MPL-2.0 — this is an independent
 * implementation of the published technique, not a port).
 *
 * Each z-slice holds a Bayer matrix at a different resolution (1×1, 2×2,
 * 4×4, 8×8), block-replicated up to a common side so all slices share
 * dimensions and the sampler can interpolate BETWEEN them. That interpolation
 * is the whole trick: as a surface approaches the camera the shader walks up
 * the slices, and because the levels are self-similar, dots only ever appear —
 * never appear and disappear at once, which is what reads as swimming.
 *
 * Generated at runtime rather than shipped as an asset: it is ~50 lines, and
 * a generator is a PURE function, so the self-similarity that makes the
 * technique work is a property test rather than a snapshot nobody can check. */
import * as THREE from 'three';

/** Slices: Bayer at 1×1, 2×2, 4×4, 8×8. */
export const DITHER_LEVELS = 4;

/** Common slice side — the finest level's own size. */
export const DITHER_RES = 1 << (DITHER_LEVELS - 1);

/** The raw integer Bayer matrix at `level`, row-major, side `2^level`.
 * Built by the standard recurrence
 * `M_2n(2y+dy, 2x+dx) = 4·M_n(y,x) + offset[dy][dx]`. */
export function bayerMatrix(level: number): number[] {
  let m = [0];
  let size = 1;
  for (let k = 0; k < level; k++) {
    const next = new Array<number>(size * size * 4);
    const nextSize = size * 2;
    // offset[dy][dx] — the canonical 2×2 ordering.
    const offset = [
      [0, 2],
      [3, 1],
    ];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const base = 4 * m[y * size + x]!;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            next[(2 * y + dy) * nextSize + (2 * x + dx)] = base + offset[dy]![dx]!;
          }
        }
      }
    }
    m = next;
    size = nextSize;
  }
  return m;
}

/** The CENTERED normalization, `(M + 0.5) / size²`.
 *
 * The centering is not cosmetic. With the plain `M / size²` the 2×2 block
 * average of level k+1 overshoots level k by a constant `1.5/(4n²)`, and the
 * levels stop being self-similar — dots would both appear and disappear
 * across a zoom. Centered, the average is exactly level k:
 *
 *   ((4M+0.5)+(4M+2.5)+(4M+3.5)+(4M+1.5)) / 4 / (4n²) = (M+0.5)/n²
 *
 * It also keeps every value strictly inside (0,1), so no dot is
 * unconditionally on or off. */
export function bayerValue(level: number, x: number, y: number): number {
  const size = 1 << level;
  return (bayerMatrix(level)[y * size + x]! + 0.5) / (size * size);
}

/** All slices packed slice-major, one byte per texel, block-replicated to
 * `DITHER_RES²`. */
export function buildDitherData(): Uint8Array {
  const sliceTexels = DITHER_RES * DITHER_RES;
  const data = new Uint8Array(sliceTexels * DITHER_LEVELS);
  for (let level = 0; level < DITHER_LEVELS; level++) {
    const size = 1 << level;
    const scale = DITHER_RES / size; // block-replication factor
    for (let y = 0; y < DITHER_RES; y++) {
      for (let x = 0; x < DITHER_RES; x++) {
        const v = bayerValue(level, Math.floor(x / scale), Math.floor(y / scale));
        // 0..255 with the same centering the float carries — v is strictly
        // inside (0,1), so this never lands on 0 or 255 spuriously.
        data[level * sliceTexels + y * DITHER_RES + x] = Math.round(v * 255);
      }
    }
  }
  return data;
}

/** The `Data3DTexture` the dither material samples. WebGL2 only — three's
 * default renderer is WebGL2, so this is safe here.
 *
 * `LinearFilter` on all three axes is required: the interpolation BETWEEN
 * slices is what makes the dot count blend continuously as the camera moves,
 * and nearest filtering would step. */
export function createDitherTexture(): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(buildDitherData(), DITHER_RES, DITHER_RES, DITHER_LEVELS);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Depth must CLAMP, not repeat — the finest slice must not wrap around to
  // the coarsest as the camera closes in.
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
