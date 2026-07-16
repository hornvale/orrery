/** The vendored wasm binary IS the contract fixture: instantiates
 * `public/hornvale_world.wasm` directly, drives it through `hw_new` +
 * `hw_scene_*`, and returns the strict-parsed documents. No committed JSON
 * copy sits between producer and consumer to drift — this is the end-to-end
 * loader shared by any test that needs a live seed-42 document. Lives
 * outside `*.test.ts` so importing it doesn't double-run its own tests. */
import { readFileSync } from "node:fs";
import { parseTiles, parseSystem, parseRegion } from "../sim/scene";
import { readOut } from "../sim/catalog";

async function exports() {
  const bytes = readFileSync("public/hornvale_world.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as any;
}

/** Instantiate the vendored binary fresh, seed 42, and return the strict-parsed tiles document. */
export async function loadSeed42Tiles(width: number) {
  const e = await exports();
  e.hw_new(42n);
  if (e.hw_scene_tiles(width) !== 0) throw new Error(readOut(e));
  return parseTiles(readOut(e));
}

/** Instantiate the vendored binary fresh, seed 42, and return the strict-parsed system document. */
export async function loadSeed42System() {
  const e = await exports();
  e.hw_new(42n);
  if (e.hw_scene_system() !== 0) throw new Error(readOut(e));
  return parseSystem(readOut(e));
}

/** Instantiate the vendored binary fresh, seed 42, and return the strict-parsed regional tiles document. */
export async function loadSeed42Region(face: number, level: number, ix: number, iy: number, samples: number) {
  const e = await exports();
  e.hw_new(42n);
  if (e.hw_scene_tiles_region(face, level, ix, iy, samples) !== 0) throw new Error(readOut(e));
  return parseRegion(readOut(e));
}
