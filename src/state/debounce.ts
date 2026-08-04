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
export interface Debounced {
  (): void;
  /** Run a pending call NOW and cancel its timer; a no-op when nothing is
   * pending. Trailing-edge debouncing has one hole — the window itself. If
   * the page goes away inside it (a close, a reload, a back-navigation),
   * that last write never happens, which is a silent data loss the caller
   * cannot see. Anything whose debounced body has an external effect
   * (persistence, telemetry) needs a `pagehide` listener that calls this.
   * Flushing an already-fired or never-scheduled call must be harmless, so
   * a listener can fire unconditionally. */
  flush(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    // Cleared before `fn`, not after, so a `flush` racing the natural fire
    // (a `pagehide` landing on the same tick) cannot run the body twice.
    timer = setTimeout(() => { timer = undefined; fn(); }, ms);
  };
  trigger.flush = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    fn();
  };
  return trigger;
}
