// The catalog: hornvale's world-wasm behind a typed loader. The ABI is
// hw_* over linear memory (hornvale spec 2026-07-14-goldengrove §3).

/** The pinned world-wasm release this client is built against (spec §5);
 * named in fetch-failure errors so a stale deploy or wrong URL is
 * unambiguous, and matches the tag the README documents. */
export const CATALOG_VERSION = "world-wasm-v4";

/** A genesis or scene call refused; `code` is the raw hw_* status. */
export class CatalogError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}

/** The wasm binary itself couldn't be fetched — distinct from a genesis
 * refusal or a malformed scene document (both require the binary to have
 * loaded first), so a caller can name the wasm URL rather than a seed. */
export class CatalogFetchError extends CatalogError {}

interface HwExports {
  memory: WebAssembly.Memory;
  hw_new(seed: bigint): number;
  hw_new_pinned(seed: bigint, len: number): number;
  hw_scene_system(): number;
  hw_scene_moons(): number;
  hw_scene_neighbors(): number;
  hw_scene_tiles(width: number): number;
  hw_in_ptr(): number;
  hw_out_ptr(): number;
  hw_out_len(): number;
}

/** Decode the wasm's out buffer as UTF-8 text. */
export function readOut(e: HwExports): string {
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.hw_out_ptr(), e.hw_out_len()));
}

/** Encode `text` as UTF-8 into the wasm's in buffer; returns the byte length written. */
export function writeIn(e: HwExports, text: string): number {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 4096) throw new CatalogError("pins JSON exceeds the 4096-byte buffer", -1);
  new Uint8Array(e.memory.buffer, e.hw_in_ptr(), bytes.length).set(bytes);
  return bytes.length;
}

/** Build a CatalogError from a non-zero status code and the out buffer's text. */
export function statusError(code: number, outText: string): CatalogError {
  let message = outText;
  try {
    const env = JSON.parse(outText);
    if (typeof env?.error === "string") message = env.error;
  } catch {
    /* raw text is the message */
  }
  return new CatalogError(message, code);
}

/** A loaded world-wasm catalog: genesis plus the two scene readers. */
export interface Catalog {
  /** Run genesis for `seed`, optionally pinned; throws CatalogError on refusal. */
  generate(seed: bigint, pins?: Record<string, string>): void;
  /** The `scene/system/v1` document as raw JSON text. */
  sceneSystem(): string;
  /** The `scene/moons/v1` document as raw JSON text. */
  sceneMoons(): string;
  /** The `scene/neighbors/v1` document as raw JSON text. */
  sceneNeighbors(): string;
  /** The `scene/tiles/v1` document (at `width` columns) as raw JSON text. */
  sceneTiles(width: number): string;
}

/** Fetch and instantiate the world-wasm catalog at `wasmUrl`. */
export async function loadCatalog(wasmUrl: string): Promise<Catalog> {
  const res = await fetch(wasmUrl);
  if (!res.ok)
    throw new CatalogFetchError(`catalog ${CATALOG_VERSION} fetch failed: ${res.status} ${wasmUrl}`, -100);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  const e = instance.exports as unknown as HwExports;
  const check = (code: number) => {
    if (code !== 0) throw statusError(code, readOut(e));
  };
  return {
    generate(seed, pins) {
      if (pins && Object.keys(pins).length > 0) {
        check(e.hw_new_pinned(seed, writeIn(e, JSON.stringify(pins))));
      } else {
        check(e.hw_new(seed));
      }
    },
    sceneSystem() {
      check(e.hw_scene_system());
      return readOut(e);
    },
    sceneMoons() {
      check(e.hw_scene_moons());
      return readOut(e);
    },
    sceneNeighbors() {
      check(e.hw_scene_neighbors());
      return readOut(e);
    },
    sceneTiles(width) {
      check(e.hw_scene_tiles(width));
      return readOut(e);
    },
  };
}
