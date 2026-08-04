/** THE registry: every control the Console offers, as data.
 *
 * This is the only module that knows both what a control is called and what
 * it does. The sheet renders it, the codec serializes it, e2e addresses it —
 * none of them know what any single entry means.
 *
 * Adding a control costs ONE entry here. No renderer edit, no callback
 * interface, no test file. That is the whole point of the indirection. */
import type { Control, ControlContext, LegendRow } from './kinds';
import { AVAILABLE } from './kinds';
import type { SheetTab } from '../sheet';
import { LENSES } from '../../views/lens';
import { LOOKS } from '../../views/look';
import { RELIEF_EXAGGERATION } from '../../views/globe';
import { SPEED_STEPS } from '../../time/speedPolicy';

export const SHEET_TABS: readonly SheetTab[] = [
  { group: 'lens', label: 'Lens' },
  { group: 'look', label: 'Look' },
  { group: 'layers', label: 'Layers' },
  { group: 'time', label: 'Time' },
];

/** The view handles each `apply` closes over. `main.ts` supplies them; the
 * registry never reaches for a view itself. */
export interface RegistryDeps {
  setLens(id: string): void;
  setLook(id: string): void;
  setWinds(on: boolean): void;
  setCurrents(on: boolean): void;
  setClouds(on: boolean): void;
  setWaves(on: boolean): void;
  setGlint(on: boolean): void;
  setNightFill(on: boolean): void;
  setTrueRelief(on: boolean): void;
  setTrueDistance(on: boolean): void;
  setHoldSpin(on: boolean): void;
  setHoldSeason(on: boolean): void;
  setRate(mult: number): void;
  /** The rung's own resting rate (`SPEED_POLICY[rung].defaultMult`) — what
   * boot actually applies, not a fixed `x1`. The rate control's `default`
   * reads this live (see below) so a session that never touches the rate
   * control never reports it as "changed" just for existing on a rung whose
   * resting pace isn't 1×. */
  rungDefaultRate(): number;
  reroll(): void;
  share(): void;
  /** The active Look's own settings, merged in at build time — dither3d's
   * seven (`ditherSettingControls`); every other Look contributes none. */
  lookSettings(): Control[];
  /** The active lens's legend rows, for the lens control's colour key. Read
   * through a function so it tracks the live lens and the live world. */
  lensLegend(): LegendRow[];
}

// Rung gates are `applies`, not `available`: a control that isn't the
// globe/system rung's business isn't a fact about the world worth reporting
// with a reason — it's simply not on screen, so it's hidden outright.
const isGlobeRung = (ctx: ControlContext) => ctx.rung === 'globe';
const isSystemRung = (ctx: ControlContext) => ctx.rung === 'system';

export function buildRegistry(d: RegistryDeps): Control[] {
  return [
    // ---- Lens -------------------------------------------------------------
    {
      kind: 'choice', id: 'lens', label: 'Lens', group: 'lens',
      options: LENSES.map((l) => ({ id: l.id, label: l.label })),
      default: 'natural',
      apply: (v) => d.setLens(v),
      legend: () => d.lensLegend(),
    },

    // ---- Look -------------------------------------------------------------
    {
      kind: 'choice', id: 'look', label: 'Look', group: 'look',
      options: LOOKS.map((l) => ({ id: l.id, label: l.label })),
      default: 'natural',
      apply: (v) => d.setLook(v),
    },
    ...d.lookSettings(),
    {
      kind: 'choice', id: 'relief', label: 'Relief', group: 'look',
      help: `Schematic exaggerates relief ${RELIEF_EXAGGERATION}× so mountains read on a rendered sphere at all. True is the honest render — the mountains are down there, the sphere just does not show them at this size.`,
      options: [
        { id: 'schematic', label: `×${RELIEF_EXAGGERATION}` },
        { id: 'true', label: 'true' },
      ],
      default: 'schematic',
      applies: isGlobeRung,
      apply: (v) => d.setTrueRelief(v === 'true'),
    },
    {
      kind: 'choice', id: 'distance', label: 'Orbit distance', group: 'look',
      help: 'Schematic compresses moon orbits onto even rungs for legibility. True is to the documents — the bodies all but vanish against the orbit’s sweep.',
      options: [{ id: 'schematic', label: 'schematic' }, { id: 'true', label: 'true' }],
      default: 'schematic',
      applies: isSystemRung,
      apply: (v) => d.setTrueDistance(v === 'true'),
    },
    {
      kind: 'toggle', id: 'waves', label: 'Waves', group: 'look',
      default: true, applies: isGlobeRung, apply: (v) => d.setWaves(v),
    },
    {
      kind: 'toggle', id: 'glint', label: 'Sun glint', group: 'look',
      default: true, applies: isGlobeRung, apply: (v) => d.setGlint(v),
    },
    {
      kind: 'toggle', id: 'night-fill', label: 'Night fill', group: 'look',
      help: 'Brighten the unlit far side so its terrain and temperature stay readable, instead of the default honest dark terminator.',
      default: false, applies: isGlobeRung, apply: (v) => d.setNightFill(v),
    },

    // ---- Layers -----------------------------------------------------------
    {
      kind: 'toggle', id: 'winds', label: 'Winds', group: 'layers',
      default: false,
      // A globe overlay: meaningless on the System/Map rungs, so hidden
      // there. On the globe it stays rendered, disabled with the reason,
      // when THIS world lacks the data — that absence is a fact about the
      // world worth showing, not a "not applicable here".
      applies: isGlobeRung,
      available: (ctx) => ctx.tiles.circulationBands !== null
        ? AVAILABLE
        : { ok: false, reason: 'no circulation bands: this world is tidally locked' },
      apply: (v) => d.setWinds(v),
    },
    {
      kind: 'toggle', id: 'currents', label: 'Ocean currents', group: 'layers',
      default: false,
      applies: isGlobeRung,
      available: (ctx) =>
        ctx.tiles.currentEast.some((v) => v !== 0) || ctx.tiles.currentNorth.some((v) => v !== 0)
          ? AVAILABLE
          : { ok: false, reason: 'no ocean-current data: this world is tidally locked' },
      apply: (v) => d.setCurrents(v),
    },
    {
      kind: 'toggle', id: 'clouds', label: 'Clouds', group: 'layers',
      default: false,
      applies: isGlobeRung,
      available: (ctx) => ctx.tiles.cloudType.some((t) => t > 0)
        ? AVAILABLE
        : { ok: false, reason: 'no clouds: every tile reports a clear sky' },
      apply: (v) => d.setClouds(v),
    },

    // ---- Time -------------------------------------------------------------
    {
      kind: 'choice', id: 'rate', label: 'Rate', group: 'time',
      options: SPEED_STEPS.map((s) => ({ id: rateId(s.mult), label: s.label })),
      // A getter, not a plain value: the resting rate differs by rung (the
      // system rung eases in at ~1 mo/s, the globe at 1 hr/s — see
      // `SPEED_POLICY`), so a fixed `x1` disagreed with what boot actually
      // applies and every fresh load reported rate as non-default. Reading
      // it live also means a rung switch that leaves rate untouched never
      // gets flagged either — only an actual user pick does.
      get default() { return rateId(d.rungDefaultRate()); },
      apply: (v) => d.setRate(Number(v.replace(/^x/, ''))),
    },
    {
      kind: 'toggle', id: 'hold-spin', label: 'Hold the spin — watch the year', group: 'time',
      help: 'Freeze the daily rotation so a year’s seasons and ice sweep past on a still globe. Held automatically above 1 day/s.',
      default: false, apply: (v) => d.setHoldSpin(v),
    },
    {
      kind: 'toggle', id: 'hold-season', label: 'Hold the season — watch a day', group: 'time',
      help: 'Pin the season so the day/night temperature pulse is watchable on its own. Composes with holding the spin — they freeze different things.',
      default: false, apply: (v) => d.setHoldSeason(v),
    },

    // ---- World (no tab — the status bar's overflow) -------------------------
    { kind: 'action', id: 'reroll', label: 'Reroll', group: 'world', run: () => d.reroll() },
    { kind: 'action', id: 'share', label: 'Share', group: 'world', run: () => d.share() },
  ];
}

/** Speed multipliers are numbers, but a choice option id must be a URL-safe
 * string — `x86400` rather than `86400` so it never reads as a bare number
 * in the hash. */
export function rateId(mult: number): string {
  return `x${mult}`;
}

/** The label `SPEED_STEPS` gives `mult`, for the transport's rate chip — the
 * chip shows the rate but does not own the picker (the Time tab does). A
 * clamped-to-cap rate that matches no step falls back to a bare multiplier. */
export function rateLabel(mult: number): string {
  return SPEED_STEPS.find((s) => s.mult === mult)?.label ?? `×${mult}`;
}
