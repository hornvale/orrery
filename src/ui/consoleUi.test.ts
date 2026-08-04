import { describe, expect, it } from 'vitest';
import { buildConsoleUi } from './consoleUi';
import type { Control, ControlContext } from './controls/kinds';
import { ControlStore } from './controls/store';

/** A FAKE registry again (see sheet.test.ts): the console assembles the three
 * pieces, it never knows what a control means. */
function fakeControls(log: string[] = []): Control[] {
  return [
    { kind: 'toggle', id: 'alpha', label: 'Alpha', group: 'layers', default: false, apply: () => {} },
    { kind: 'choice', id: 'lens', label: 'Lens', group: 'lens',
      options: [{ id: 'natural', label: 'natural' }], default: 'natural', apply: () => {} },
    { kind: 'toggle', id: 'rate', label: 'Rate', group: 'time', default: false, apply: () => {} },
    { kind: 'action', id: 'reroll', label: 'Reroll', group: 'world', run: () => { log.push('reroll'); } },
  ];
}

const TABS = [
  { group: 'lens' as const, label: 'Lens' },
  { group: 'layers' as const, label: 'Layers' },
  { group: 'time' as const, label: 'Time' },
];

const GLOBE: ControlContext = { rung: 'globe', tiles: {} as never, lookId: 'natural' };

function mount(log: string[] = []) {
  const controls = fakeControls(log);
  const store = new ControlStore(controls);
  const consoleUi = buildConsoleUi({
    controls, store, tabs: TABS,
    onRung: () => {}, onPlayPause: () => {}, onScrub: () => {}, onEclipseMark: () => {},
  });
  consoleUi.refresh(GLOBE);
  return { consoleUi, store, el: consoleUi.element };
}

describe('the console', () => {
  it('mounts the status bar, the sheet and the transport under one root', () => {
    const { el } = mount();
    expect(el.querySelector('.status-bar')).not.toBeNull();
    expect(el.querySelector('.sheet')).not.toBeNull();
    expect(el.querySelector('.transport')).not.toBeNull();
  });

  it('docks the transport beside the sheet, so opening the sheet cannot move it', () => {
    const { el } = mount();
    const dock = el.querySelector('.console-dock')!;
    expect([...dock.children].map((c) => c.className)).toEqual(['sheet', 'transport']);
  });

  // The scale caption carries decision 0022's honesty disclosures (the relief
  // exaggeration factor, the schematic moon rungs). Appended to `#app` beside
  // the console it was a `position: absolute` sibling of the dock with no
  // `z-index`, so the dock — later in tree order — painted over it and the
  // text was invisible at every viewport width. Inside the dock's own flex
  // column it cannot be covered by the dock.
  it('lays the footer out inside the dock, below the transport, so nothing can paint over it', () => {
    const controls = fakeControls();
    const store = new ControlStore(controls);
    const footer = document.createElement('div');
    footer.className = 'scale-caption';
    const consoleUi = buildConsoleUi({
      controls, store, tabs: TABS, footer,
      onRung: () => {}, onPlayPause: () => {}, onScrub: () => {}, onEclipseMark: () => {},
    });
    const dock = consoleUi.element.querySelector('.console-dock')!;
    expect([...dock.children].map((c) => c.className)).toEqual(['sheet', 'transport', 'scale-caption']);
  });

  it('renders the world group — which has no tab of its own — from the overflow', () => {
    const log: string[] = [];
    const { el } = mount(log);
    expect(el.querySelector('[data-control="reroll"]')).toBeNull();
    (el.querySelector('.status-overflow') as HTMLButtonElement).click();
    (el.querySelector('[data-control="reroll"] .control-action') as HTMLButtonElement).click();
    expect(log).toEqual(['reroll']);
  });

  it('leaves every tab unmarked while the tabless world group is showing', () => {
    const { el } = mount();
    (el.querySelector('.status-overflow') as HTMLButtonElement).click();
    expect(el.querySelectorAll('.sheet-tab.active')).toHaveLength(0);
  });

  it('opens the Lens tab from the lens chip and the Time tab from the date chip', () => {
    const { el, consoleUi } = mount();
    (el.querySelector('[data-status="date"]') as HTMLButtonElement).click();
    expect(consoleUi.sheet.activeTab()).toBe('time');
    (el.querySelector('[data-status="lens"]') as HTMLButtonElement).click();
    expect(consoleUi.sheet.activeTab()).toBe('lens');
  });

  it('opens the Time tab from the transport rate chip', () => {
    const { el, consoleUi } = mount();
    (el.querySelector('[data-transport="rate"]') as HTMLButtonElement).click();
    expect(consoleUi.sheet.activeTab()).toBe('time');
  });

  it('re-evaluates availability against the context it is refreshed with', () => {
    const controls: Control[] = [
      { kind: 'toggle', id: 'alpha', label: 'Alpha', group: 'layers', default: false,
        available: (ctx) => ctx.rung === 'globe' ? { ok: true } : { ok: false, reason: 'globe only' },
        apply: () => {} },
    ];
    const store = new ControlStore(controls);
    const consoleUi = buildConsoleUi({
      controls, store, tabs: [{ group: 'layers', label: 'Layers' }],
      onRung: () => {}, onPlayPause: () => {}, onScrub: () => {}, onEclipseMark: () => {},
    });
    consoleUi.refresh(GLOBE);
    expect(consoleUi.element.querySelector('.control.unavailable')).toBeNull();
    consoleUi.refresh({ ...GLOBE, rung: 'system' });
    expect(consoleUi.element.querySelector('.control.unavailable')).not.toBeNull();
  });
});
