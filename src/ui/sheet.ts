/** Renders the control registry as a tabbed sheet. Knows NOTHING about any
 * individual control — it walks `controls`, groups by `group`, skips any
 * that don't `applies()` to the current context, and asks each of the rest's
 * `available()` whether to disable it. That is the whole point: adding a
 * control edits the registry, not this file and not its test. */
import type { Control, ControlContext, GroupId } from './controls/kinds';
import { appliesTo, availabilityOf } from './controls/kinds';
import type { ControlStore } from './controls/store';

export interface SheetTab {
  group: GroupId;
  label: string;
}

export interface Sheet {
  element: HTMLElement;
  /** Rebuild the body for `ctx` (availability depends on it). Keeps the tab. */
  render(ctx: ControlContext): void;
  setTab(group: GroupId): void;
  activeTab(): GroupId;
}

export function buildSheet(opts: {
  controls: readonly Control[];
  store: ControlStore;
  tabs: readonly SheetTab[];
  /** Bespoke chrome to append after a group's controls. The sheet appends
   * these opaque nodes and knows nothing about them — the seam that lets the
   * date field live in the Time tab without becoming a control kind. */
  extras?: Partial<Record<GroupId, HTMLElement[]>>;
}): Sheet {
  const { controls, store, tabs } = opts;
  const element = el('div', 'sheet');
  const grabber = el('div', 'sheet-grabber');
  const tabRow = el('div', 'sheet-tabs');
  const body = el('div', 'sheet-body');
  element.append(grabber, tabRow, body);

  let active: GroupId = tabs[0]!.group;
  let lastCtx: ControlContext | null = null;

  for (const tab of tabs) {
    const b = el('button', 'sheet-tab');
    b.dataset.tab = tab.group;
    b.textContent = tab.label;
    b.addEventListener('click', () => { setTab(tab.group); });
    tabRow.appendChild(b);
  }

  function markTabs(): void {
    for (const b of tabRow.querySelectorAll('.sheet-tab')) {
      b.classList.toggle('active', (b as HTMLElement).dataset.tab === active);
    }
  }

  function render(ctx: ControlContext): void {
    lastCtx = ctx;
    markTabs();
    body.replaceChildren();
    let shown = 0;
    for (const c of controls) {
      if (c.group !== active) continue;
      if (!appliesTo(c, ctx)) continue;
      body.appendChild(renderControl(c, ctx, store));
      shown++;
    }
    const extras = opts.extras?.[active] ?? [];
    for (const extra of extras) body.appendChild(extra);
    // Every control in the active group can turn out non-applying at once
    // (e.g. the Layers tab's three overlays are all globe-only) — a blank
    // box then reads as broken rather than as "nothing applies here". Only
    // when there's also no bespoke extra (the Time tab's date field would
    // otherwise make an occupied tab look empty).
    if (shown === 0 && extras.length === 0) {
      const empty = el('div', 'sheet-empty');
      empty.textContent = 'Nothing here applies to the current view.';
      body.appendChild(empty);
    }
  }

  function setTab(group: GroupId): void {
    active = group;
    if (lastCtx) render(lastCtx);
    else markTabs();
  }

  // Most store changes may alter what should be displayed — a Look switch
  // changes which settings are available, a toggle flips its own active
  // class — so they re-render the visible group.
  //
  // A SLIDER write must not. A re-render replaces the <input> that is
  // currently under the user's finger, which ends the drag: the slider would
  // move exactly one step per touch. A slider write needs no structural
  // change anyway (its readout is updated locally), so it is skipped.
  const sliderIds = new Set(controls.filter((c) => c.kind === 'slider').map((c) => c.id));
  store.subscribe((changedId) => {
    if (changedId !== null && sliderIds.has(changedId)) return;
    if (lastCtx) render(lastCtx);
  });

  return { element, render, setTab, activeTab: () => active };
}

function renderControl(c: Control, ctx: ControlContext, store: ControlStore): HTMLElement {
  const wrap = el('div', 'control');
  wrap.dataset.control = c.id;
  const avail = availabilityOf(c, ctx);
  const disabled = !avail.ok;
  if (disabled) wrap.classList.add('unavailable');

  const label = el('div', 'control-label');
  label.textContent = c.label;
  wrap.appendChild(label);

  if (c.kind === 'toggle') {
    const b = el('button', 'control-toggle');
    b.textContent = c.label;
    b.disabled = disabled;
    b.classList.toggle('active', store.get(c.id) === true);
    b.addEventListener('click', () => { store.set(c.id, store.get(c.id) !== true); });
    wrap.appendChild(b);
  } else if (c.kind === 'choice') {
    const row = el('div', 'control-options');
    for (const o of c.options) {
      const b = el('button', 'control-option');
      b.dataset.option = o.id;
      b.textContent = o.label;
      b.disabled = disabled;
      b.classList.toggle('active', store.get(c.id) === o.id);
      b.addEventListener('click', () => { store.set(c.id, o.id); });
      row.appendChild(b);
    }
    wrap.appendChild(row);
    if (c.legend) {
      const box = el('div', 'control-legend');
      for (const row of c.legend()) {
        const item = el('div', 'control-legend-row');
        const sw = el('span', 'control-swatch');
        sw.style.background = `rgb(${row.swatch[0]}, ${row.swatch[1]}, ${row.swatch[2]})`;
        const label = el('span', 'control-legend-label');
        label.textContent = row.label;
        item.append(sw, label);
        box.appendChild(item);
      }
      wrap.appendChild(box);
    }
  } else if (c.kind === 'slider') {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'control-slider';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(store.get(c.id) ?? c.default);
    input.disabled = disabled;
    const readout = el('span', 'control-value');
    const show = (v: number): void => { readout.textContent = c.format ? c.format(v) : String(v); };
    show(Number(input.value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      show(v);
      store.set(c.id, v);
    });
    const row = el('div', 'control-slider-row');
    row.append(input, readout);
    wrap.appendChild(row);
  } else {
    const b = el('button', 'control-action');
    b.textContent = c.label;
    b.disabled = disabled;
    b.addEventListener('click', () => { store.run(c.id); });
    wrap.appendChild(b);
  }

  if (c.help !== undefined) {
    const help = el('div', 'control-help');
    help.textContent = c.help;
    wrap.appendChild(help);
  }
  if (!avail.ok) {
    const reason = el('div', 'control-reason');
    reason.textContent = avail.reason;
    wrap.appendChild(reason);
  }
  return wrap;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
