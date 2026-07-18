// worker.ts — genesis off the main thread (it takes seconds), and region-tile
// (LOD) requests served from the already-generated world.
import { CatalogFetchError, loadCatalog, type Catalog } from "./catalog";
import {
  parseEclipses,
  parseMoons,
  parseNeighbors,
  parseRegion,
  parseSystem,
  parseTiles,
  SceneFormatError,
} from "./scene";

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

// The catalog persists across messages so a region request reuses the world
// genesis already built (genesis is seconds; a region tile is instant).
let catalog: Catalog | null = null;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === "region") {
    // A LOD region tile for the already-generated world (main.ts posts these
    // after 'world' lands, so the catalog is set). `key` round-trips so the
    // globe can match the reply to the tile that asked for it.
    try {
      if (!catalog) throw new Error("region requested before genesis");
      const region = parseRegion(
        catalog.sceneTilesRegion(msg.face, msg.level, msg.ix, msg.iy, msg.samples),
      );
      self.postMessage({ type: "region", key: msg.key, region });
    } catch (err) {
      self.postMessage({
        type: "region-error",
        key: msg.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  const { seed, pins, tilesWidth } = msg;
  try {
    catalog = await loadCatalog(catalogUrl(import.meta.env.BASE_URL, self.location.origin));
    catalog.generate(BigInt(seed), pins);
    const system = parseSystem(catalog.sceneSystem());
    const moons = parseMoons(catalog.sceneMoons());
    const neighbors = parseNeighbors(catalog.sceneNeighbors());
    const tiles = parseTiles(catalog.sceneTiles(tilesWidth));
    // The displayed year's eclipses (day scrubber marks, Task 7): the whole
    // scrubber range, [0, yearDays) — matches setDayRange's own extent.
    const eclipses = parseEclipses(catalog.sceneEclipses(0, system.world.yearDays));
    self.postMessage({ type: "world", system, moons, neighbors, tiles, eclipses });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      kind: errorKind(err),
    });
  }
};
