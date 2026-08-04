/** Trailing-edge debounce: `fn` runs at most once per `ms` of quiet. Every
 * call within the window cancels and reschedules the pending run, so a
 * rapid burst — a slider firing its `input` event on every drag tick —
 * collapses to ONE call after activity actually stops.
 *
 * `fn` takes no arguments and is expected to read whatever is current
 * (store state, DOM value, …) when it finally runs — not a value captured
 * at call time — so the one call that does happen always sees the latest
 * state, never a stale snapshot from earlier in the burst. That is what
 * guarantees the final value is always the one that lands, never dropped. */
export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
