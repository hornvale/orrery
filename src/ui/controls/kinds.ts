/** A CONTROL is one thing the viewer can change, described as data rather
 * than wired by hand. Four kinds cover the whole surface; anything that
 * doesn't fit stays bespoke (the day scrubber and the info card, by
 * decision — see the Console spec §1).
 *
 * The point of the indirection is that adding a control costs ONE entry:
 * the sheet renderer, the URL codec and the availability/disabled treatment
 * are all generic over this type. The old HUD threaded each control through
 * four places plus a test edit. */
import type { ZoomTarget } from '../../views/zoom';
import type { TilesScene } from '../../sim/scene';

export type GroupId = 'lens' | 'look' | 'layers' | 'time' | 'world';

/** Why a control cannot be used right now. The reason is shown to the
 * viewer next to the disabled control — never a silently missing control. */
export type Availability = { ok: true } | { ok: false; reason: string };

export const AVAILABLE: Availability = { ok: true };

/** What `available()` gets to decide on. */
export interface ControlContext {
  rung: ZoomTarget;
  tiles: TilesScene;
  lookId: string;
}

export type ControlValue = boolean | string | number;

interface ControlBase {
  /** Stable. The URL codec writes it, e2e addresses it, the DOM carries it
   * as `data-control`. One name, three consumers — never rename casually. */
  id: string;
  label: string;
  group: GroupId;
  /** Caption shown beneath the control. */
  help?: string;
  /** Absent means always available. */
  available?(ctx: ControlContext): Availability;
}

export interface Toggle extends ControlBase {
  kind: 'toggle';
  default: boolean;
  apply(v: boolean): void;
}

export interface Choice extends ControlBase {
  kind: 'choice';
  options: Array<{ id: string; label: string }>;
  default: string;
  apply(v: string): void;
}

export interface Slider extends ControlBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  default: number;
  apply(v: number): void;
  /** How the current value reads next to the label. Defaults to the raw number. */
  format?(v: number): string;
}

export interface Action extends ControlBase {
  kind: 'action';
  run(): void;
}

export type Control = Toggle | Choice | Slider | Action;

/** An action has no value; everything else does. */
export function defaultValueOf(c: Control): ControlValue | undefined {
  return c.kind === 'action' ? undefined : c.default;
}

/** Whether `c` may be used under `ctx`. Controls with no predicate are
 * always available. */
export function availabilityOf(c: Control, ctx: ControlContext): Availability {
  return c.available ? c.available(ctx) : AVAILABLE;
}
