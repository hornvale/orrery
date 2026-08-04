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

  // This span is the ONLY on-screen display of the seed anywhere in the
  // app — the `world` tab the overflow button opens holds just Reroll and
  // Share (registry.ts), neither of which shows the value. A u64 seed can
  // run to 20 digits, which does not fit a phone-width status bar next to
  // the nav, the lens chip and the date chip, so it is shown shortened
  // (last 6 digits) with the full value in `title` — never hidden outright.
  let rawSeed = '';
  return {
    element,
    setRung: (v) => {
      for (const [id, b] of rungButtons) b.classList.toggle('active', id === v);
    },
    setDate: (s) => { date.textContent = s; },
    setLens: (label) => { lens.textContent = label; },
    setSeed: (s) => {
      rawSeed = s;
      seed.textContent = shortSeedLabel(s);
      seed.title = `seed ${s}`;
    },
    flashShared: () => {
      seed.textContent = 'copied ✓';
      setTimeout(() => { seed.textContent = shortSeedLabel(rawSeed); }, 1500);
    },
  };
}

/** `seed 42` in full for anything short enough to just fit. A long u64 seed
 * (up to 20 digits) shortens to `#…<last 6 digits>` — the `#` marks it as an
 * identifier rather than a lens/date label, and dropping the word "seed"
 * buys back the few characters that make the difference between fitting a
 * 375px-wide status bar and not. The full value is always still reachable
 * via the `title` attribute set above. */
function shortSeedLabel(s: string): string {
  return s.length > 6 ? `#…${s.slice(-6)}` : `seed ${s}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
