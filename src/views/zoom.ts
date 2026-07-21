/** The zoom ladder between the system view and the globe view: a camera
 * dolly on the system view's camera from its wide orrery framing toward a
 * close framing on the world's own position (`worldPosition(day)`, Task
 * 8), timed against an opacity cross-fade between the two views' stacked
 * canvases (main.ts's `mountViews` owns the canvases/renderers themselves).
 *
 * Two kinds of surface, matching system.ts's split: pure math
 * (`easeInOutCubic`, `lerp`, `lerpVector3`, `dollyPosition`, `dollyLookAt`,
 * `ZoomController`) is unit-tested directly below; the actual camera/canvas
 * wiring lives in main.ts and is preview-verified only (no GPU in tests).
 */
import * as THREE from 'three';

/** Cubic ease-in-out on [0,1]: slow start, fast middle, slow finish.
 * Symmetric — `easeInOutCubic(1 - t) === 1 - easeInOutCubic(t)`. Inputs
 * outside [0,1] clamp rather than extrapolate, so a caller can feed a raw
 * (possibly overshooting) elapsed/duration ratio directly. */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Plain linear interpolation; callers pass an already-eased/clamped `t`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Component-wise `lerp` for a three.js position. */
export function lerpVector3(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  return new THREE.Vector3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
}

/** How long a system<->globe zoom transition takes, in milliseconds. */
export const ZOOM_DURATION_MS = 1500;

export type ZoomTarget = 'system' | 'globe' | 'map';

/** Each rung's position on the ladder — the value `ZoomController.valueAt`
 * eases toward. Ordered altitude descent: system (0) → globe (1) → map (2). */
export const RUNG_INDEX: Record<ZoomTarget, number> = { system: 0, globe: 1, map: 2 };

/** The zoom's continuous state at a given moment: how far the transition
 * has eased along the ladder (0 = fully system, 1 = fully globe, 2 = fully
 * map), and the per-canvas opacities a caller cross-fades with. */
export interface ZoomState {
  value: number;
  systemOpacity: number;
  globeOpacity: number;
  mapOpacity: number;
}

/** The three canvases' cross-fade opacities at ladder position `pos`: each
 * rung is a triangular tent centered on its own `RUNG_INDEX`, fully opaque
 * at its center and fully transparent one whole rung away, so adjacent
 * rungs cross-fade linearly and non-adjacent rungs never overlap. */
export function opacitiesFor(pos: number): Omit<ZoomState, 'value'> {
  const tri = (center: number) => Math.max(0, 1 - Math.abs(pos - center));
  return { systemOpacity: tri(0), globeOpacity: tri(1), mapOpacity: tri(2) };
}

/** Drives one system<->globe transition over `durationMs`. Retargeting
 * mid-transition (rapid toggling) eases onward from wherever the previous
 * transition had actually reached, never from that transition's start or
 * from a hard 0/1 — so the camera and cross-fade never jump. */
export class ZoomController {
  private target: ZoomTarget = 'system';
  private fromValue = 0;
  private transitionStartMs = 0;

  constructor(private readonly durationMs: number = ZOOM_DURATION_MS) {}

  /** Which view the controller is currently headed to (or already at). */
  currentTarget(): ZoomTarget {
    return this.target;
  }

  /** Begin transitioning to `target` as of `nowMs`; a no-op if the
   * controller is already headed there. */
  setTarget(target: ZoomTarget, nowMs: number): void {
    if (target === this.target) return;
    this.fromValue = this.valueAt(nowMs);
    this.transitionStartMs = nowMs;
    this.target = target;
  }

  /** Snap directly to `target` with no transition — for the initial view
   * off a deep link, where "the last 1.5s eased in from system" would be a
   * lie about history that never happened. */
  jumpTo(target: ZoomTarget): void {
    this.target = target;
    this.fromValue = RUNG_INDEX[target];
    this.transitionStartMs = 0;
  }

  /** The eased ladder position toward `target` at `nowMs`. */
  valueAt(nowMs: number): number {
    const goal = RUNG_INDEX[this.target];
    const raw = this.durationMs <= 0 ? 1 : (nowMs - this.transitionStartMs) / this.durationMs;
    return lerp(this.fromValue, goal, easeInOutCubic(raw));
  }

  /** The full state (value + opacities) at `nowMs`. */
  stateAt(nowMs: number): ZoomState {
    const value = this.valueAt(nowMs);
    return { value, ...opacitiesFor(value) };
  }
}

/** The system camera's dolly position at zoom-`value`: `systemFraming` when
 * fully at the system view, `worldPos + closeOffset` (a close framing on
 * the world's own position) when fully at the globe view. */
export function dollyPosition(
  systemFraming: THREE.Vector3,
  worldPos: THREE.Vector3,
  closeOffset: THREE.Vector3,
  value: number,
): THREE.Vector3 {
  const closeFraming = worldPos.clone().add(closeOffset);
  return lerpVector3(systemFraming, closeFraming, value);
}

/** The system camera's look-at point at zoom-`value`: the star (the system
 * root's origin) when fully at the system view, `worldPos` when fully at
 * the globe view. */
export function dollyLookAt(worldPos: THREE.Vector3, value: number): THREE.Vector3 {
  return lerpVector3(new THREE.Vector3(0, 0, 0), worldPos, value);
}
