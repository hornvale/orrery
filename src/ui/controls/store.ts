/** Holds every control's current value and calls its `apply` when it
 * changes. No DOM: the sheet renderer subscribes, it is not consulted.
 *
 * Values for controls that are not currently RENDERED are still held here —
 * a Look's own settings persist while another Look is showing, so switching
 * away and back restores them, and a shared link carries them. */
import type { Control, ControlValue } from './kinds';
import { defaultValueOf } from './kinds';

export class ControlStore {
  private readonly byId = new Map<string, Control>();
  private readonly values = new Map<string, ControlValue>();
  private readonly listeners = new Set<(changedId: string | null) => void>();

  constructor(controls: readonly Control[]) {
    for (const c of controls) {
      this.byId.set(c.id, c);
      const d = defaultValueOf(c);
      if (d !== undefined) this.values.set(c.id, d);
    }
  }

  get(id: string): ControlValue | undefined {
    return this.values.get(id);
  }

  /** Set `id` to `v`, run its side effect, notify. An unknown id is ignored
   * rather than fatal — the same tolerance the URL codec relies on. */
  set(id: string, v: ControlValue): void {
    const c = this.byId.get(id);
    if (!c || c.kind === 'action') return;
    this.values.set(id, v);
    applyTo(c, v);
    this.notify(id);
  }

  /** Run an action's side effect. Actions hold no value, so this notifies
   * nothing — whatever the action changed reports itself. */
  run(id: string): void {
    const c = this.byId.get(id);
    if (c?.kind === 'action') c.run();
  }

  /** Only what differs from the defaults — what the codec serializes, so a
   * plain link stays plain. */
  nonDefaults(): Record<string, ControlValue> {
    const out: Record<string, ControlValue> = {};
    for (const [id, v] of this.values) {
      const c = this.byId.get(id)!;
      if (v !== defaultValueOf(c)) out[id] = v;
    }
    return out;
  }

  reset(): void {
    for (const [id, c] of this.byId) {
      const d = defaultValueOf(c);
      if (d === undefined) continue;
      this.values.set(id, d);
      applyTo(c, d);
    }
    this.notify(null);
  }

  /** `fn` receives the id that changed, or null when many did (a reset).
   * Subscribers that rebuild DOM use it to avoid replacing the very element
   * that is mid-interaction — see the sheet's slider guard. */
  subscribe(fn: (changedId: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(changedId: string | null): void {
    for (const fn of this.listeners) fn(changedId);
  }
}

/** Narrow `v` to the kind's own parameter type. The store's map is typed on
 * the union, so each branch needs its own cast — one place, not per call site. */
function applyTo(c: Control, v: ControlValue): void {
  if (c.kind === 'toggle') c.apply(v as boolean);
  else if (c.kind === 'choice') c.apply(v as string);
  else if (c.kind === 'slider') c.apply(v as number);
}
