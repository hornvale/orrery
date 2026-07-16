import { LENSES, type Lens, type LegendEntry } from '../views/lens';

export const SPEED_STEPS: Array<{ label: string; mult: number }> = [
  { label: '1×', mult: 1 },
  { label: '1 min/s', mult: 60 },
  { label: '1 hr/s', mult: 3600 },
  { label: '1 day/s', mult: 86400 },
  { label: '10 d/s', mult: 864000 },
  { label: '~1 mo/s', mult: 2.6e6 },
];

export interface HudCallbacks {
  onPlayPause(): void;
  onSpeed(mult: number): void;
  onTrueScale(): void;
  onReroll(): void;
  onShare(): void;
  onDateJump(year: number, dayOfYear: number): void;
  onToggleView(): void;
  /** The day scrubber was dragged to `day` (raw ephemeris day units, not a
   * calendar date) — the caller repositions the view and rebases autoplay
   * from here. */
  onScrub(day: number): void;
  /** The viewer picked a lens (by `Lens.id`). */
  onLens(id: string): void;
}

export interface Hud {
  setDate(s: string): void;
  setPaused(paused: boolean): void;
  flashShared(): void;
  setActiveSpeed(mult: number): void;
  setViewButton(label: string, visible: boolean): void;
  setMaxSpeed(maxMult: number | null): void;
  setTrueScaleLabel(label: string): void;
  setTrueScaleActive(on: boolean): void;
  /** The scrubber's max day (its full-range extent, e.g. one world year). */
  setDayRange(maxDay: number): void;
  /** Moves the scrubber to `day` without firing onScrub — for autoplay
   * driving the slider, as opposed to the user dragging it. */
  setDay(day: number): void;
  /** Show `lens` as active: mark its button, draw its legend, show its caption. */
  setLens(lens: Lens, legend: LegendEntry[]): void;
}

export function buildHud(root: HTMLElement, seed: string, cb: HudCallbacks): Hud {
  const topLeft = el('div', 'hud hud-top-left');
  topLeft.append(el('span', '', `seed ${seed}`));
  const reroll = el('button', '', '⟲ reroll');
  reroll.addEventListener('click', () => cb.onReroll());
  const trueScale = el('button', '', 'true scale');
  // Stateless about which mode it serves (orrery trueScale vs. ground
  // reliefScale) — the click just reports "toggle happened"; the caller
  // decides what that means and drives activeness back via
  // setTrueScaleActive(). Never flip the active class here: with two
  // independent semantic toggles sharing this one button, an internal flip
  // desyncs from whichever toggle isn't currently in view.
  trueScale.addEventListener('click', () => cb.onTrueScale());
  const share = el('button', '', 'share');
  share.addEventListener('click', () => cb.onShare());
  topLeft.append(reroll, trueScale, share);
  const viewToggle = el('button', '', '');
  (viewToggle as HTMLButtonElement).name = 'view-toggle';
  viewToggle.style.display = 'none';
  viewToggle.addEventListener('click', () => cb.onToggleView());
  topLeft.append(viewToggle);

  const topRight = el('div', 'hud hud-top-right');
  const date = el('span', '', '—');
  topRight.append(date);
  const jumpYear = document.createElement('input');
  jumpYear.name = 'jump-year';
  jumpYear.placeholder = 'Y';
  jumpYear.style.width = '4.5em';
  const jumpDay = document.createElement('input');
  jumpDay.name = 'jump-day';
  jumpDay.placeholder = 'day';
  jumpDay.style.width = '3.5em';
  const jumpGo = el('button', '', 'jump');
  (jumpGo as HTMLButtonElement).name = 'jump-go';
  jumpGo.addEventListener('click', () => {
    const y = Math.max(1, Math.floor(Number(jumpYear.value)));
    const d = Math.max(1, Math.floor(Number(jumpDay.value) || 1));
    if (Number.isFinite(y)) cb.onDateJump(y - 1, d - 1);
  });
  topRight.append(jumpYear, jumpDay, jumpGo);

  const bottom = el('div', 'hud hud-bottom');
  const play = el('button', '', '⏸');
  play.addEventListener('click', () => cb.onPlayPause());
  bottom.append(play);
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of SPEED_STEPS) {
    const b = el('button', '', s.label);
    b.addEventListener('click', () => {
      speedButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      cb.onSpeed(s.mult);
    });
    speedButtons.push(b);
    bottom.append(b);
  }

  // The orrery's day scrubber — a distinct control from the calendar
  // play/speed row above: it drags a raw ephemeris `day` (the system view's
  // native unit), not a calendar date. Dragging it fires onScrub;
  // setDay() moves it back without re-firing (autoplay driving the UI).
  const scrubberRow = el('div', 'hud hud-scrubber');
  const dayLabel = el('span', '', 'day 0');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.name = 'day-scrubber';
  scrub.min = '0';
  scrub.max = '1000'; // placeholder — the caller sets the real range via setDayRange() once a world loads
  scrub.step = '0.01';
  scrub.value = '0';
  scrub.addEventListener('input', () => {
    const day = Number(scrub.value);
    dayLabel.textContent = `day ${day.toFixed(1)}`;
    cb.onScrub(day);
  });
  scrubberRow.append(scrub, dayLabel);

  // The lens picker: one button per registered lens (LENSES), generically —
  // no per-lens branch. Adding a future lens costs one file and zero HUD
  // edits.
  const lensRow = el('div', 'hud-lenses');
  const lensButtons = new Map<string, HTMLButtonElement>();
  for (const lens of LENSES) {
    const b = el('button', '', lens.label);
    b.addEventListener('click', () => cb.onLens(lens.id));
    lensButtons.set(lens.id, b);
    lensRow.appendChild(b);
  }
  const legendBox = el('div', 'hud-legend');
  const lensCaption = el('div', 'hud-caption');

  root.append(topLeft, topRight, bottom, scrubberRow, lensRow, legendBox, lensCaption);
  const hud: Hud = {
    setDate: (s) => { date.textContent = s; },
    setPaused: (p) => { play.textContent = p ? '▶' : '⏸'; },
    flashShared: () => {
      share.textContent = 'copied ✓';
      setTimeout(() => { share.textContent = 'share'; }, 1500);
    },
    setActiveSpeed: (mult) => {
      speedButtons.forEach((b, i) => b.classList.toggle('active', SPEED_STEPS[i]!.mult === mult));
    },
    setViewButton: (label, visible) => {
      viewToggle.textContent = label;
      viewToggle.style.display = visible ? '' : 'none';
    },
    setMaxSpeed: (maxMult) => {
      speedButtons.forEach((b, i) => {
        b.disabled = maxMult !== null && SPEED_STEPS[i]!.mult > maxMult;
      });
    },
    setTrueScaleLabel: (label) => { trueScale.textContent = label; },
    setTrueScaleActive: (on) => { trueScale.classList.toggle('active', on); },
    setDayRange: (maxDay) => { scrub.max = String(maxDay); },
    setDay: (day) => {
      scrub.value = String(day);
      dayLabel.textContent = `day ${day.toFixed(1)}`;
    },
    setLens(lens, legend) {
      for (const [id, b] of lensButtons) b.classList.toggle('active', id === lens.id);
      legendBox.replaceChildren();
      for (const row of legend) {
        const item = el('div', 'hud-legend-row');
        const sw = el('span', 'hud-swatch');
        sw.style.background = `rgb(${row.swatch[0]}, ${row.swatch[1]}, ${row.swatch[2]})`;
        item.append(sw, el('span', 'hud-legend-label', row.label));
        legendBox.appendChild(item);
      }
      lensCaption.textContent = lens.caption;
    },
  };
  hud.setActiveSpeed(1);
  return hud;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
