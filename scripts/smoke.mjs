#!/usr/bin/env node
// A real-catalog node smoke test (hornvale spec 2026-07-14-goldengrove §6):
// loads the actual public/hornvale_world.wasm from disk and drives it
// through the same hw_* ABI src/sim/catalog.ts uses — no browser, no
// imports object, just WebAssembly.instantiate against raw bytes. This is
// the one check that would have caught a wasm build whose exports or
// schema drifted from what the client expects, since every other test
// exercises the TypeScript side against fakes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "public", "hornvale_world.wasm");

function fail(reason) {
  console.error(`smoke: ${reason}`);
  process.exit(1);
}

function readOut(exports) {
  const ptr = exports.hw_out_ptr();
  const len = exports.hw_out_len();
  return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
}

let bytes;
try {
  bytes = await readFile(wasmPath);
} catch (err) {
  fail(`couldn't read ${wasmPath}: ${err.message}`);
}

let exports;
try {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  exports = instance.exports;
} catch (err) {
  fail(`couldn't instantiate ${wasmPath}: ${err.message}`);
}

const newCode = exports.hw_new(42n);
if (newCode !== 0) fail(`hw_new(42) returned ${newCode}, expected 0: ${readOut(exports)}`);

const sceneCode = exports.hw_scene_system();
if (sceneCode !== 0) fail(`hw_scene_system() returned ${sceneCode}, expected 0: ${readOut(exports)}`);

const systemText = readOut(exports);
let system;
try {
  system = JSON.parse(systemText);
} catch (err) {
  fail(`scene/system/v1 out buffer wasn't valid JSON: ${err.message}`);
}
if (system.schema !== "scene/system/v1") fail(`expected schema "scene/system/v1", got ${JSON.stringify(system.schema)}`);
if (system.seed !== 42) fail(`expected seed 42, got ${JSON.stringify(system.seed)}`);

const tilesCode = exports.hw_scene_tiles(256);
if (tilesCode !== 0) fail(`hw_scene_tiles(256) returned ${tilesCode}, expected 0: ${readOut(exports)}`);

const tilesText = readOut(exports);
let tiles;
try {
  tiles = JSON.parse(tilesText);
} catch (err) {
  fail(`scene/tiles/v1 out buffer wasn't valid JSON: ${err.message}`);
}
if (tiles.schema !== "scene/tiles/v1") fail(`expected schema "scene/tiles/v1", got ${JSON.stringify(tiles.schema)}`);

console.log("smoke: hw_new(42) -> 0, scene/system/v1 (seed 42), scene/tiles/v1(256) all ok");
