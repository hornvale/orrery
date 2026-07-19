import { LENSES, type Lens, type LegendEntry } from '../views/lens';
import type { EclipseEvent } from '../sim/scene';
import { eclipseMarkPositions } from './eclipseMarks';

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
  /** The viewer toggled the prevailing-wind overlay. Never fires while the
   * control is disabled (no circulation bands) — the browser's own
   * `disabled` attribute blocks the click before this callback is reached. */
  onWinds(): void;
  /** The viewer toggled the ocean-current advection overlay (The Gyre). Never
   * fires while the control is disabled (no current data — a locked world
   * zeroes the whole field) — the browser's own `disabled` attribute blocks
   * the click before this callback is reached. */
  onCurrents(): void;
  /** The viewer toggled the cloud advection overlay (The Rains). Never fires
   * while the control is disabled (no wind to advect along — a locked world
   * reports no circulation bands, or no tile clears the cloud-fraction
   * threshold) — the browser's own `disabled` attribute blocks the click
   * before this callback is reached. */
  onClouds(): void;
  /** The viewer clicked an eclipse mark on the day scrubber. */
  onEclipseMark(event: EclipseEvent): void;
  /** The viewer toggled the spin freeze: hold the globe's daily rotation so a
   * year's seasons and ice are watchable at speed, decoupled from the clock
   * rate. Overrides the automatic hold-at-fast-rates behavior. */
  onFreezeSpin(): void;
  /** The viewer toggled Task 6's "watch a day" hold: pin the temperature
   * lens' season so the diurnal (day/night) pulse is watchable on its own,
   * without the seasonal baseline also drifting underneath it. Composes
   * with `onFreezeSpin` — an orthogonal hold, not a replacement for it. */
  onDayHold(): void;
  /** The viewer toggled the ocean's drifting wave pattern. */
  onWaves(): void;
  /** The viewer toggled the ocean's sun-glint (specular highlight). */
  onGlint(): void;
  /** The viewer toggled the night-side fill: brighten the unlit hemisphere so
   * the far side (its terrain, its temperature) is readable through the
   * night, instead of the default honest dark terminator. */
  onNightFill(): void;
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
  /** Enables or disables the winds toggle. When unavailable, `reason` names
   * why (a tidally locked world has no circulation bands) — shown next to
   * the disabled button rather than the control silently vanishing. */
  setWindsAvailable(available: boolean, reason?: string): void;
  /** Marks the winds toggle's on/off state (only meaningful while available). */
  setWindsActive(on: boolean): void;
  /** Enables or disables the currents toggle. When unavailable, `reason`
   * names why (a locked world has no ocean-current data) — shown next to the
   * disabled button rather than the control silently vanishing. */
  setCurrentsAvailable(available: boolean, reason?: string): void;
  /** Marks the currents toggle's on/off state (only meaningful while available). */
  setCurrentsActive(on: boolean): void;
  /** Enables or disables the clouds toggle. When unavailable, `reason` names
   * why (a locked world has no wind to advect along, or no tile clears the
   * cloud threshold) — shown next to the disabled button rather than the
   * control silently vanishing. */
  setCloudsAvailable(available: boolean, reason?: string): void;
  /** Marks the clouds toggle's on/off state (only meaningful while available). */
  setCloudsActive(on: boolean): void;
  /** Rebuilds the day scrubber's eclipse marks for the displayed year's
   * `events`, placed against `maxDay` (the scrubber's own range). */
  setEclipses(events: EclipseEvent[], maxDay: number): void;
  /** Marks the freeze-spin toggle's on/off state. */
  setFreezeSpinActive(on: boolean): void;
  /** Marks the day-hold ("watch a day") toggle's on/off state. */
  setDayHoldActive(on: boolean): void;
  /** Marks the ocean wave-pattern toggle's on/off state. */
  setWavesActive(on: boolean): void;
  /** Marks the ocean sun-glint toggle's on/off state. */
  setGlintActive(on: boolean): void;
  /** Marks the night-side fill toggle's on/off state. */
  setNightFillActive(on: boolean): void;
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
  // Decouple the globe's daily spin from the clock: freeze the rotation so a
  // year's seasons/ice sweep past on a still globe (the terminator keeps
  // tracking the season). Forces the hold on at any speed, overriding the
  // automatic hold-at-fast-rates.
  const freezeSpin = el('button', '', 'freeze spin');
  (freezeSpin as HTMLButtonElement).name = 'freeze-spin';
  freezeSpin.title = 'Hold the daily spin so seasons and ice are watchable at any speed';
  freezeSpin.addEventListener('click', () => cb.onFreezeSpin());
  bottom.append(freezeSpin);

  // Task 6's "watch a day": pin the temperature lens' season so the diurnal
  // day/night pulse is watchable on its own — composes with freeze-spin
  // above rather than replacing it (one freezes the mesh's visual spin,
  // this one freezes the season).
  const dayHold = el('button', '', 'watch a day');
  (dayHold as HTMLButtonElement).name = 'day-hold';
  dayHold.title = 'Hold the season so the day/night temperature pulse is watchable on its own';
  dayHold.addEventListener('click', () => cb.onDayHold());
  bottom.append(dayHold);

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
  // The eclipse marks overlay MUST be a child of this positioned
  // scrubberRow (it carries the base `hud` class's `position: absolute`,
  // which is what makes an absolutely-positioned child land over the track
  // at all) — a loose element on `root` was invisible AND unclickable
  // (Task 7's regression, caught only by a later visual pass, not jsdom).
  const eclipseMarksEl = el('div', 'hud-eclipse-marks');
  scrubberRow.append(scrub, dayLabel, eclipseMarksEl);

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

  // The prevailing-wind overlay: an overlay, not a lens (it composes with
  // whichever lens is active), but the lens panel is the one HUD container
  // that already carries the base `hud` positioning class — a loose element
  // outside it repeats Task 7's invisible/unclickable regression.
  const windsToggle = el('button', '', 'winds');
  (windsToggle as HTMLButtonElement).name = 'winds-toggle';
  windsToggle.addEventListener('click', () => cb.onWinds());
  const windsReason = el('span', 'hud-winds-reason', '');
  const windsRow = el('div', 'hud-winds-row');
  windsRow.append(windsToggle, windsReason);

  // The Gyre's ocean-current advection overlay: same "overlay beside the
  // lens panel" placement as winds above, for the same reason (a loose
  // element outside the positioned lens panel repeats Task 7's
  // invisible/unclickable regression).
  const currentsToggle = el('button', '', 'currents');
  (currentsToggle as HTMLButtonElement).name = 'currents-toggle';
  currentsToggle.addEventListener('click', () => cb.onCurrents());
  const currentsReason = el('span', 'hud-winds-reason', '');
  const currentsRow = el('div', 'hud-winds-row');
  currentsRow.append(currentsToggle, currentsReason);

  // The Rains' cloud advection overlay: same "overlay beside the lens panel"
  // placement as winds/currents above, for the same reason.
  const cloudsToggle = el('button', '', 'clouds');
  (cloudsToggle as HTMLButtonElement).name = 'clouds-toggle';
  cloudsToggle.addEventListener('click', () => cb.onClouds());
  const cloudsReason = el('span', 'hud-winds-reason', '');
  const cloudsRow = el('div', 'hud-winds-row');
  cloudsRow.append(cloudsToggle, cloudsReason);

  // Ocean-surface effect toggles: the drifting wave pattern and the sun-glint
  // (both material properties of the ocean; only visible under the natural
  // lens, but always togglable). Default on, matching the material defaults.
  const wavesToggle = el('button', '', 'waves');
  (wavesToggle as HTMLButtonElement).name = 'waves-toggle';
  wavesToggle.addEventListener('click', () => cb.onWaves());
  const glintToggle = el('button', '', 'glint');
  (glintToggle as HTMLButtonElement).name = 'glint-toggle';
  glintToggle.addEventListener('click', () => cb.onGlint());
  // Night-side fill: a globe-lighting toggle grouped with the surface effects
  // (off by default — the honest dark terminator).
  const nightFillToggle = el('button', '', 'night fill');
  (nightFillToggle as HTMLButtonElement).name = 'night-fill-toggle';
  nightFillToggle.title = 'Brighten the unlit far side so its terrain and temperature stay readable';
  nightFillToggle.addEventListener('click', () => cb.onNightFill());
  const oceanRow = el('div', 'hud-winds-row');
  oceanRow.append(wavesToggle, glintToggle, nightFillToggle);

  const lensPanel = el('div', 'hud hud-lens-panel');
  lensPanel.append(lensRow, legendBox, lensCaption, windsRow, currentsRow, cloudsRow, oceanRow);

  root.append(topLeft, topRight, bottom, scrubberRow, lensPanel);
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
    setWindsAvailable: (available, reason) => {
      (windsToggle as HTMLButtonElement).disabled = !available;
      windsReason.textContent = available ? '' : (reason ?? '');
    },
    setWindsActive: (on) => { windsToggle.classList.toggle('active', on); },
    setCurrentsAvailable: (available, reason) => {
      (currentsToggle as HTMLButtonElement).disabled = !available;
      currentsReason.textContent = available ? '' : (reason ?? '');
    },
    setCurrentsActive: (on) => { currentsToggle.classList.toggle('active', on); },
    setCloudsAvailable: (available, reason) => {
      (cloudsToggle as HTMLButtonElement).disabled = !available;
      cloudsReason.textContent = available ? '' : (reason ?? '');
    },
    setCloudsActive: (on) => { cloudsToggle.classList.toggle('active', on); },
    setEclipses: (events, maxDay) => {
      eclipseMarksEl.replaceChildren();
      for (const mark of eclipseMarkPositions(events, maxDay)) {
        const markEl = el('button', `hud-eclipse-mark hud-eclipse-${mark.body} hud-eclipse-${mark.kind}`);
        markEl.style.left = `${mark.leftFraction * 100}%`;
        markEl.title = `${mark.body} ${mark.kind} eclipse — day ${mark.event.day.toFixed(1)}`;
        markEl.addEventListener('click', () => cb.onEclipseMark(mark.event));
        eclipseMarksEl.appendChild(markEl);
      }
    },
    setFreezeSpinActive: (on) => { freezeSpin.classList.toggle('active', on); },
    setDayHoldActive: (on) => { dayHold.classList.toggle('active', on); },
    setWavesActive: (on) => { wavesToggle.classList.toggle('active', on); },
    setGlintActive: (on) => { glintToggle.classList.toggle('active', on); },
    setNightFillActive: (on) => { nightFillToggle.classList.toggle('active', on); },
  };
  hud.setActiveSpeed(1);
  hud.setWavesActive(true);
  hud.setGlintActive(true);
  return hud;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
