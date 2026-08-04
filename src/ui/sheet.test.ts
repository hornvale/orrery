import { describe, expect, it } from 'vitest';
import type { Control, ControlContext } from './controls/kinds';
import { ControlStore } from './controls/store';
import { buildSheet } from './sheet';

/** A FAKE registry. The point of the sheet is that it is generic over the
 * control list, so this test must never need editing when a real control is
 * added — if it does, the renderer has grown a special case. */
function fakeControls(log: string[] = []): Control[] {
  return [
    { kind: 'toggle', id: 'alpha', label: 'Alpha', group: 'layers', default: false,
      apply: (v) => { log.push(`alpha:${v}`); } },
    { kind: 'toggle', id: 'beta', label: 'Beta', group: 'layers', default: false,
      help: 'the second one',
      available: (ctx) => ctx.rung === 'globe' ? { ok: true } : { ok: false, reason: 'globe only' },
      apply: () => {} },
    { kind: 'choice', id: 'gamma', label: 'Gamma', group: 'look',
      options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
      default: 'one', apply: (v) => { log.push(`gamma:${v}`); } },
    { kind: 'slider', id: 'delta', label: 'Delta', group: 'look',
      min: 0, max: 10, step: 1, default: 5, apply: (v) => { log.push(`delta:${v}`); } },
    { kind: 'action', id: 'epsilon', label: 'Epsilon', group: 'world',
      run: () => { log.push('epsilon'); } },
  ];
}

const TABS = [
  { group: 'layers' as const, label: 'Layers' },
  { group: 'look' as const, label: 'Look' },
];

const GLOBE: ControlContext = { rung: 'globe', tiles: {} as never, lookId: 'natural' };
const SYSTEM: ControlContext = { rung: 'system', tiles: {} as never, lookId: 'natural' };

function mount(log: string[] = [], ctx = GLOBE) {
  const controls = fakeControls(log);
  const store = new ControlStore(controls);
  const sheet = buildSheet({ controls, store, tabs: TABS });
  sheet.render(ctx);
  return { sheet, store, el: sheet.element };
}

describe('the sheet renderer', () => {
  it('renders one tab button per tab', () => {
    const { el } = mount();
    expect([...el.querySelectorAll('.sheet-tab')].map((t) => t.getAttribute('data-tab')))
      .toEqual(['layers', 'look']);
  });

  it('shows only the active tab group', () => {
    const { el } = mount();
    expect(el.querySelector('[data-control="alpha"]')).not.toBeNull();
    expect(el.querySelector('[data-control="gamma"]')).toBeNull();
  });

  it('switches groups when a tab is clicked', () => {
    const { el, sheet } = mount();
    (el.querySelector('.sheet-tab[data-tab="look"]') as HTMLButtonElement).click();
    expect(sheet.activeTab()).toBe('look');
    expect(el.querySelector('[data-control="gamma"]')).not.toBeNull();
    expect(el.querySelector('[data-control="alpha"]')).toBeNull();
  });

  it('marks the active tab', () => {
    const { el } = mount();
    const active = [...el.querySelectorAll('.sheet-tab.active')];
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-tab')).toBe('layers');
  });

  it('a toggle click writes through the store to the control', () => {
    const log: string[] = [];
    const { el, store } = mount(log);
    (el.querySelector('[data-control="alpha"] button') as HTMLButtonElement).click();
    expect(store.get('alpha')).toBe(true);
    expect(log).toEqual(['alpha:true']);
  });

  it('a choice renders one button per option and reports the chosen id', () => {
    const log: string[] = [];
    const { el, sheet, store } = mount(log);
    sheet.setTab('look');
    const opts = [...el.querySelectorAll('[data-control="gamma"] [data-option]')];
    expect(opts.map((o) => o.getAttribute('data-option'))).toEqual(['one', 'two']);
    (opts[1] as HTMLButtonElement).click();
    expect(store.get('gamma')).toBe('two');
    expect(log).toEqual(['gamma:two']);
  });

  it('a slider reports its numeric value', () => {
    const log: string[] = [];
    const { el, sheet, store } = mount(log);
    sheet.setTab('look');
    const input = el.querySelector('[data-control="delta"] input') as HTMLInputElement;
    expect(input.value).toBe('5');
    input.value = '8';
    input.dispatchEvent(new Event('input'));
    expect(store.get('delta')).toBe(8);
    expect(log).toEqual(['delta:8']);
  });

  it('does NOT replace the slider element on a slider write — a re-render mid-drag would end the drag', () => {
    const { el, sheet } = mount();
    sheet.setTab('look');
    const before = el.querySelector('[data-control="delta"] input') as HTMLInputElement;
    before.value = '8';
    before.dispatchEvent(new Event('input'));
    const after = el.querySelector('[data-control="delta"] input');
    expect(after).toBe(before);
    expect(el.querySelector('[data-control="delta"] .control-value')!.textContent).toBe('8');
  });

  it('DOES re-render on a choice write, so the newly active option is marked', () => {
    const { el, sheet } = mount();
    sheet.setTab('look');
    (el.querySelector('[data-control="gamma"] [data-option="two"]') as HTMLButtonElement).click();
    const active = el.querySelectorAll('[data-control="gamma"] .control-option.active');
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-option')).toBe('two');
  });

  it('an unavailable control is disabled and says why', () => {
    const { el } = mount([], SYSTEM);
    const beta = el.querySelector('[data-control="beta"]')!;
    expect(beta.classList.contains('unavailable')).toBe(true);
    expect((beta.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(beta.querySelector('.control-reason')!.textContent).toBe('globe only');
  });

  it('an available control carries no reason', () => {
    const { el } = mount();
    const beta = el.querySelector('[data-control="beta"]')!;
    expect(beta.classList.contains('unavailable')).toBe(false);
    expect(beta.querySelector('.control-reason')).toBeNull();
  });

  it('renders a controls help text as its caption', () => {
    const { el } = mount();
    expect(el.querySelector('[data-control="beta"] .control-help')!.textContent)
      .toBe('the second one');
  });

  it('re-render reflects a context change without losing the active tab', () => {
    const { el, sheet } = mount([], GLOBE);
    sheet.setTab('layers');
    sheet.render(SYSTEM);
    expect(sheet.activeTab()).toBe('layers');
    expect(el.querySelector('[data-control="beta"]')!.classList.contains('unavailable')).toBe(true);
  });
});
