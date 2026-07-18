// worker.ts — genesis off the main thread (it takes seconds).
import { CatalogFetchError, loadCatalog } from "./catalog";
import { parseMoons, parseNeighbors, parseSystem, parseTiles, SceneFormatError } from "./scene";

/** How main.ts distinguishes the three worker failure modes it renders as
 * distinct, styled full-screen states: the catalog binary itself never
 * loaded, genesis refused the seed, or a landed scene document failed its
 * own schema check. */
export type WorkerErrorKind = "catalog-fetch" | "genesis" | "schema" | "unknown";

/** Join Vite's `BASE_URL` (e.g. `/orrery/` under GitHub Pages, `/` in local
 * dev/preview) with `origin` to build the deployed catalog wasm's absolute
 * URL — an unqualified `/hornvale_world.wasm` ignores the Pages sub-path and
 * 404s. Tolerates a base missing its trailing slash.
 *
 * The base MUST be absolute (start with `/`). A relative base (`./`, ``)
 * resolved against a bare `origin` silently drops the sub-path — the wasm
 * url becomes rootless and 404s under any Pages sub-path (orrery#7). Vite's
 * `base` config (and the deploy's `--base=/orrery/`) must stay absolute; a
 * relative one fails here rather than in a user's browser. */
export function catalogUrl(baseUrl: string, origin: string): string {
  if (!baseUrl.startsWith("/")) {
    throw new Error(
      `catalogUrl needs an absolute base (got ${JSON.stringify(baseUrl)}); ` +
        `a relative base drops the Pages sub-path and 404s (orrery#7)`,
    );
  }
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${base}hornvale_world.wasm`, origin).href;
}

function errorKind(err: unknown): WorkerErrorKind {
  if (err instanceof CatalogFetchError) return "catalog-fetch";
  if (err instanceof SceneFormatError) return "schema";
  if (err instanceof Error) return "genesis";
  return "unknown";
}

self.onmessage = async (ev: MessageEvent) => {
  const { seed, pins, tilesWidth } = ev.data;
  try {
    const catalog = await loadCatalog(catalogUrl(import.meta.env.BASE_URL, self.location.origin));
    catalog.generate(BigInt(seed), pins);
    const system = parseSystem(catalog.sceneSystem());
    const moons = parseMoons(catalog.sceneMoons());
    const neighbors = parseNeighbors(catalog.sceneNeighbors());
    const tiles = parseTiles(catalog.sceneTiles(tilesWidth));
    self.postMessage({ type: "world", system, moons, neighbors, tiles });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      kind: errorKind(err),
    });
  }
};
