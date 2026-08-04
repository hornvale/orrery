/** The persistent top chrome: which rung is showing, the active lens, the
 * date, the seed, and an overflow button for the `world` control group
 * (seed / reroll / share — they have no tab of their own).
 *
 * The lens chip and the date are tappable shortcuts to their tabs; the bar
 * never changes state on its own, exactly like the old HUD's trueScale
 * button — the caller owns the state and drives it back through the setters. */
import type { ZoomTarget } from '../views/zoom';

export interface StatusBar {
  element: HTMLElement;
  setRung(v: ZoomTarget): void;
  setDate(s: string): void;
  setLens(label: string): void;
  setSeed(seed: string): void;
  flashShared(): void;
}

const RUNGS: Array<{ id: ZoomTarget; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'globe', label: 'Globe' },
  { id: 'map', label: 'Map' },
];

export function buildStatusBar(cb: {
  onRung(v: ZoomTarget): void;
  onOverflow(): void;
  onLensChip(): void;
  onDateChip(): void;
}): StatusBar {
  const element = el('div', 'status-bar');

  const seg = el('div', 'rung-segmented');
  const rungButtons = new Map<ZoomTarget, HTMLButtonElement>();
  for (const r of RUNGS) {
    const b = el('button', 'rung');
    b.dataset.rung = r.id;
    b.textContent = r.label;
    b.addEventListener('click', () => cb.onRung(r.id));
    rungButtons.set(r.id, b);
    seg.appendChild(b);
  }

  const lens = el('button', 'status-chip');
  lens.dataset.status = 'lens';
  lens.addEventListener('click', () => cb.onLensChip());

  const spacer = el('div', 'status-spacer');

  const date = el('button', 'status-chip');
  date.dataset.status = 'date';
  date.textContent = '—';
  date.addEventListener('click', () => cb.onDateChip());

  const seed = el('span', 'status-seed');
  seed.dataset.status = 'seed';

  const overflow = el('button', 'status-overflow');
  overflow.textContent = '⋯';
  overflow.setAttribute('aria-label', 'more');
  overflow.addEventListener('click', () => cb.onOverflow());

  element.append(seg, lens, spacer, date, seed, overflow);

  let seedText = '';
  return {
    element,
    setRung: (v) => {
      for (const [id, b] of rungButtons) b.classList.toggle('active', id === v);
    },
    setDate: (s) => { date.textContent = s; },
    setLens: (label) => { lens.textContent = label; },
    setSeed: (s) => { seedText = `seed ${s}`; seed.textContent = seedText; },
    flashShared: () => {
      seed.textContent = 'copied ✓';
      setTimeout(() => { seed.textContent = seedText; }, 1500);
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
