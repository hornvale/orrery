/** The vendored wasm binary IS the contract fixture: instantiates
 * `public/hornvale_world.wasm` directly, drives it through `hw_new` +
 * `hw_scene_*`, and returns the strict-parsed documents. No committed JSON
 * copy sits between producer and consumer to drift — this is the end-to-end
 * loader shared by any test that needs a live seed-42 document. Lives
 * outside `*.test.ts` so importing it doesn't double-run its own tests.
 *
 * Each loader below memoizes its result behind a module-level cache keyed on
 * its arguments: the wasm instantiate + `hw_new` + `hw_scene_*` round trip is
 * the expensive part (seconds, not milliseconds), and every call with the
 * same arguments produces the exact same seed-42 document, so there is
 * nothing to gain by paying for it twice. This is safe ONLY because nothing
 * downstream mutates the returned document — verified across every consumer
 * (`views/globe.ts`, `views/lens.ts`, `views/plateColoring.ts`, and every
 * `*.test.ts` that imports these loaders) before this cache was added; a
 * future test that needs a mutated copy must `structuredClone` it rather
 * than write through the shared reference. Caching the in-flight *promise*
 * (not just the resolved value) also collapses concurrent same-argument
 * calls within a test file into one instantiation. Vitest isolates module
 * state per test *file* by default, so this cache warms once per file, not
 * once for the whole run — exactly the win needed under file-level
 * parallelism. */
import { readFileSync } from "node:fs";
import { parseTiles, parseSystem, parseRegion } from "../sim/scene";
import { readOut } from "../sim/catalog";

async function exports() {
  const bytes = readFileSync("public/hornvale_world.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as any;
}

const tilesCache = new Map<number, Promise<ReturnType<typeof parseTiles>>>();

/** Instantiate the vendored binary, seed 42, and return the strict-parsed
 * tiles document — cached per `width` after the first call. */
export async function loadSeed42Tiles(width: number) {
  let cached = tilesCache.get(width);
  if (!cached) {
    cached = (async () => {
      const e = await exports();
      e.hw_new(42n);
      if (e.hw_scene_tiles(width) !== 0) throw new Error(readOut(e));
      return parseTiles(readOut(e));
    })();
    tilesCache.set(width, cached);
  }
  return cached;
}

let systemCache: Promise<ReturnType<typeof parseSystem>> | null = null;

/** Instantiate the vendored binary, seed 42, and return the strict-parsed
 * system document — cached after the first call. */
export async function loadSeed42System() {
  if (!systemCache) {
    systemCache = (async () => {
      const e = await exports();
      e.hw_new(42n);
      if (e.hw_scene_system() !== 0) throw new Error(readOut(e));
      return parseSystem(readOut(e));
    })();
  }
  return systemCache;
}

const regionCache = new Map<string, Promise<ReturnType<typeof parseRegion>>>();

/** Instantiate the vendored binary, seed 42, and return the strict-parsed
 * regional tiles document — cached per `(face, level, ix, iy, samples)`
 * after the first call. */
export async function loadSeed42Region(face: number, level: number, ix: number, iy: number, samples: number) {
  const key = `${face},${level},${ix},${iy},${samples}`;
  let cached = regionCache.get(key);
  if (!cached) {
    cached = (async () => {
      const e = await exports();
      e.hw_new(42n);
      if (e.hw_scene_tiles_region(face, level, ix, iy, samples) !== 0) throw new Error(readOut(e));
      return parseRegion(readOut(e));
    })();
    regionCache.set(key, cached);
  }
  return cached;
}
