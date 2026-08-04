/** Assembles the three pieces of the control surface — status bar, sheet,
 * transport — and keeps them consistent. Owns no state of its own: it
 * forwards to the store and re-renders on a context change.
 *
 * Named `ConsoleUi`, not `Console`: `console` is a global, and a local
 * binding of that name in `main.ts` would shadow it. */
import type { Control, ControlContext } from './controls/kinds';
import type { ControlStore } from './controls/store';
import { buildSheet, type Sheet, type SheetTab } from './sheet';
import { buildStatusBar, type StatusBar } from './statusBar';
import { buildTransport, type Transport } from './transport';
import type { ZoomTarget } from '../views/zoom';
import type { EclipseEvent } from '../sim/scene';

export interface ConsoleUi {
  element: HTMLElement;
  statusBar: StatusBar;
  sheet: Sheet;
  transport: Transport;
  /** Re-evaluate every control's availability and repaint the visible group. */
  refresh(ctx: ControlContext): void;
}

export function buildConsoleUi(opts: {
  controls: readonly Control[];
  store: ControlStore;
  tabs: readonly SheetTab[];
  onRung(v: ZoomTarget): void;
  onPlayPause(): void;
  onScrub(day: number): void;
  onEclipseMark(e: EclipseEvent): void;
}): ConsoleUi {
  const sheet = buildSheet({ controls: opts.controls, store: opts.store, tabs: opts.tabs });
  const statusBar = buildStatusBar({
    onRung: opts.onRung,
    // `world` is a GroupId with no tab of its own — `setTab` accepts it and
    // `markTabs` simply matches no tab button, so the overflow renders the
    // world group (seed / reroll / share) with every tab unmarked.
    onOverflow: () => { sheet.setTab('world'); },
    onLensChip: () => sheet.setTab('lens'),
    onDateChip: () => sheet.setTab('time'),
  });
  const transport = buildTransport({
    onPlayPause: opts.onPlayPause,
    onScrub: opts.onScrub,
    onEclipseMark: opts.onEclipseMark,
    onRateChip: () => sheet.setTab('time'),
  });

  const element = document.createElement('div');
  element.className = 'console';
  // The sheet's collapsed state IS the transport strip, so the transport
  // lives inside the sheet's own container rather than beside it — that is
  // what keeps it from moving when the sheet is dragged open.
  const dock = document.createElement('div');
  dock.className = 'console-dock';
  dock.append(sheet.element, transport.element);
  element.append(statusBar.element, dock);

  return {
    element, statusBar, sheet, transport,
    refresh: (ctx) => sheet.render(ctx),
  };
}
