/** Request scheduling for the globe's region patches (The Cascade).
 *
 * Pure: no three.js, no globe state, no producer calls. Given the tiles the
 * globe wants patches for and where the camera is looking, decide which to
 * ask for next and how many may be outstanding at once.
 *
 * The worker serving these is serial regardless, so the in-flight cap is not
 * about parallelism — it is about keeping the queue RE-ORDERABLE. A camera
 * move mid-cascade should re-prioritize what has not been asked for yet
 * rather than waiting out a stale queue. */
import { tileCenterUnit, tileKey, type TileId, type V3 } from './cubeSphere';

/** Outstanding requests allowed at once. Small on purpose: the queue can only
 * be re-prioritized ahead of what has already been dealt. */
export const CASCADE_MAX_IN_FLIGHT = 4;

/** Failed-request retries allowed before a tile is given up on. */
export const CASCADE_MAX_ATTEMPTS = 2;

export interface Cascade {
  /** Add tiles wanting patches. Already-pending, in-flight, and permanently
   * settled tiles are ignored, so callers may submit the same set every
   * frame — a tile that failed and has retries left is queued again. */
  submit(tiles: readonly TileId[]): void;
  /** Re-sort what has not yet been dealt, camera-facing first. */
  reprioritize(cameraUnit: V3): void;
  /** Take the next batch to request, respecting the in-flight cap. */
  next(): TileId[];
  /** Resolve a dealt tile, freeing its slot. `ok: true` (the patch arrived)
   * retires the tile permanently. `ok: false` (the request failed) counts
   * the attempt and retires the tile only once it has been attempted
   * `maxAttempts` times; until then a later `submit` re-queues it.
   *
   * This departs on purpose from the pre-cascade policy, which never retried
   * a failed region at all: the failed key was left marked so a
   * persistently-failing region would not be re-requested on every rebuild.
   * That was safe while only deep-zoom tiles used patches — a failure just
   * cost detail nobody was looking at. Now that the base globe is
   * patch-served, the same failure would leave a permanently coarse tile in
   * the DEFAULT view, so failures here get a bounded number of retries
   * instead of none. Retrying is driven by the caller re-submitting its
   * still-patchless tiles each frame (`globe.ts`'s `dealRegionRequests`);
   * `settle` only frees the slot and counts the attempt. */
  settle(tile: TileId, ok: boolean): void;
  readonly pending: number;
  readonly inFlight: number;
}

export function createCascade(opts?: { maxInFlight?: number; maxAttempts?: number }): Cascade {
  const cap = opts?.maxInFlight ?? CASCADE_MAX_IN_FLIGHT;
  const maxAttempts = opts?.maxAttempts ?? CASCADE_MAX_ATTEMPTS;
  let queue: TileId[] = [];
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const settled = new Set<string>();
  const attempts = new Map<string, number>();
  // Camera direction as of the last reprioritize; identity ordering until then.
  let camera: V3 | null = null;

  const score = (t: TileId): number => {
    if (camera === null) return 0;
    const c = tileCenterUnit(t);
    // Dot product against the camera direction: larger = more camera-facing.
    // Negated so a plain ascending sort puts facing tiles first.
    return -(c[0] * camera[0] + c[1] * camera[1] + c[2] * camera[2]);
  };

  return {
    submit(tiles) {
      for (const t of tiles) {
        const k = tileKey(t);
        if (queued.has(k) || inFlight.has(k) || settled.has(k)) continue;
        queued.add(k);
        queue.push(t);
      }
      if (camera !== null) queue.sort((a, b) => score(a) - score(b));
    },
    reprioritize(cameraUnit) {
      camera = cameraUnit;
      queue.sort((a, b) => score(a) - score(b));
    },
    next() {
      const out: TileId[] = [];
      while (queue.length > 0 && inFlight.size < cap) {
        const t = queue.shift()!;
        const k = tileKey(t);
        queued.delete(k);
        inFlight.add(k);
        out.push(t);
      }
      return out;
    },
    settle(tile, ok) {
      const k = tileKey(tile);
      inFlight.delete(k);
      if (ok) {
        settled.add(k);
        return;
      }
      const count = (attempts.get(k) ?? 0) + 1;
      attempts.set(k, count);
      if (count >= maxAttempts) settled.add(k);
    },
    get pending() {
      return queue.length;
    },
    get inFlight() {
      return inFlight.size;
    },
  };
}
