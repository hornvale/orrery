import { describe, expect, it } from 'vitest';
import { buildHud, SPEED_STEPS } from './hud';
import { LENSES, moistureLens } from '../views/lens';

describe('buildHud interactions', () => {
  const noop = { onPlayPause() {}, onSpeed(_: number) {}, onTrueScale() {}, onReroll() {}, onShare() {}, onDateJump(_: number, __: number) {}, onToggleView() {}, onScrub(_: number) {}, onLens(_: string) {}, onWinds() {}, onFreezeSpin() {}, onWaves() {}, onGlint() {}, onNightFill() {} };

  it('share button fires onShare and flashes', () => {
    const root = document.createElement('div');
    let shared = 0;
    const hud = buildHud(root, '42', { ...noop, onShare: () => { shared++; } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'share')!;
    btn.click();
    expect(shared).toBe(1);
    hud.flashShared();
    expect(btn.textContent).toBe('copied ✓');
  });

  it('date-jump submits 0-based year and day', () => {
    const root = document.createElement('div');
    let got: [number, number] | null = null;
    buildHud(root, '42', { ...noop, onDateJump: (y, d) => { got = [y, d]; } });
    (root.querySelector('input[name="jump-year"]') as HTMLInputElement).value = '412';
    (root.querySelector('input[name="jump-day"]') as HTMLInputElement).value = '14';
    (root.querySelector('button[name="jump-go"]') as HTMLButtonElement).click();
    expect(got).toEqual([411, 13]); // UI is 1-based, engine is 0-based
  });

  it('setActiveSpeed highlights the matching step', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    hud.setActiveSpeed(86400);
    const active = [...root.querySelectorAll('.hud-bottom button.active')];
    expect(active.length).toBe(1);
    expect(active[0]!.textContent).toBe(SPEED_STEPS.find((s) => s.mult === 86400)!.label);
  });

  it('setMaxSpeed disables steps above the cap; null re-enables all', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const speedButtons = [...root.querySelectorAll('.hud-bottom button')].slice(1) as HTMLButtonElement[]; // drop play/pause

    hud.setMaxSpeed(3600);
    const expectedDisabled = SPEED_STEPS.filter((s) => s.mult > 3600).length;
    expect(speedButtons.filter((b) => b.disabled).length).toBe(expectedDisabled);
    SPEED_STEPS.forEach((s, i) => { expect(speedButtons[i]!.disabled).toBe(s.mult > 3600); });

    hud.setMaxSpeed(null);
    expect(speedButtons.every((b) => !b.disabled)).toBe(true);
  });

  it('setTrueScaleLabel relabels the true-scale button', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    hud.setTrueScaleLabel('⛰ ×3 relief');
    expect(btn.textContent).toBe('⛰ ×3 relief');
  });

  it('true-scale button click fires onTrueScale without flipping its own active class', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onTrueScale: () => { calls++; } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    btn.click();
    expect(calls).toBe(1);
    expect(btn.classList.contains('active')).toBe(false); // hud is stateless — the caller owns activeness
    btn.click();
    expect(calls).toBe(2);
    expect(btn.classList.contains('active')).toBe(false); // still not flipped after a second click
  });

  it('setTrueScaleActive sets and clears the active class independent of clicks', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    hud.setTrueScaleActive(true);
    expect(btn.classList.contains('active')).toBe(true);
    hud.setTrueScaleActive(false);
    expect(btn.classList.contains('active')).toBe(false);
    // clicking never toggles it on its own — only the explicit setter does
    btn.click();
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('dragging the day scrubber fires onScrub with the parsed day', () => {
    const root = document.createElement('div');
    let got: number | null = null;
    buildHud(root, '42', { ...noop, onScrub: (day) => { got = day; } });
    const scrub = root.querySelector('input[name="day-scrubber"]') as HTMLInputElement;
    scrub.value = '12.5';
    scrub.dispatchEvent(new Event('input'));
    expect(got).toBe(12.5);
  });

  it('setDay moves the scrubber without firing onScrub', () => {
    const root = document.createElement('div');
    let scrubs = 0;
    const hud = buildHud(root, '42', { ...noop, onScrub: () => { scrubs++; } });
    const scrub = root.querySelector('input[name="day-scrubber"]') as HTMLInputElement;
    hud.setDay(30);
    expect(scrub.value).toBe('30');
    expect(scrubs).toBe(0); // autoplay driving the UI must not loop back as a user scrub
  });

  it('setDayRange sets the scrubber max', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    hud.setDayRange(368.05357);
    const scrub = root.querySelector('input[name="day-scrubber"]') as HTMLInputElement;
    expect(scrub.max).toBe('368.05357');
  });

  it('view-toggle button is controllable', () => {
    const root = document.createElement('div');
    let toggles = 0;
    const hud = buildHud(root, '42', { ...noop, onToggleView: () => { toggles++; } });
    const btn = root.querySelector('button[name="view-toggle"]') as HTMLButtonElement;
    expect(btn.style.display).toBe('none'); // hidden until controller decides
    hud.setViewButton('⏚ stand here', true);
    expect(btn.style.display).toBe('');
    expect(btn.textContent).toBe('⏚ stand here');
    btn.click();
    expect(toggles).toBe(1);
  });

  it('offers a button per registered lens, with no per-lens special-casing', () => {
    const root = document.createElement('div');
    buildHud(root, '42', noop);
    for (const lens of LENSES) {
      expect(root.textContent, lens.id).toContain(lens.label);
    }
  });

  it('reports the chosen lens id', () => {
    const root = document.createElement('div');
    const chosen: string[] = [];
    buildHud(root, '42', { ...noop, onLens: (id: string) => { chosen.push(id); } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'temperature')!;
    btn.click();
    expect(chosen).toEqual(['temperature']);
  });

  it('shows the active lens caption and legend', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    // moistureLens.legend ignores its argument (its rows are fixed endpoints),
    // so no scene is needed here.
    hud.setLens(moistureLens, moistureLens.legend(undefined as never));
    expect(root.textContent).toContain('not rainfall');
    expect(root.textContent).toContain('0 — dry');
  });

  it('marks only the active lens button', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    hud.setLens(moistureLens, moistureLens.legend(undefined as never));
    const active = [...root.querySelectorAll('.hud-lenses button.active')];
    expect(active.map((b) => b.textContent)).toEqual(['moisture']);
  });

  it('winds toggle fires onWinds when available', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onWinds: () => { calls++; } });
    hud.setWindsAvailable(true);
    const btn = root.querySelector('button[name="winds-toggle"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(calls).toBe(1);
  });

  it('winds toggle is disabled with the reason on a locked world, not hidden', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onWinds: () => { calls++; } });
    hud.setWindsAvailable(false, 'no circulation bands: this world is tidally locked');
    const btn = root.querySelector('button[name="winds-toggle"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(root.textContent).toContain('no circulation bands: this world is tidally locked');
    btn.click(); // a disabled button does not dispatch a click handler at all
    expect(calls).toBe(0);
  });

  it('setWindsActive toggles the active class', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const btn = root.querySelector('button[name="winds-toggle"]') as HTMLButtonElement;
    hud.setWindsActive(true);
    expect(btn.classList.contains('active')).toBe(true);
    hud.setWindsActive(false);
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('freeze-spin toggle fires onFreezeSpin and reflects its active state', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onFreezeSpin: () => { calls++; } });
    const btn = root.querySelector('button[name="freeze-spin"]') as HTMLButtonElement;
    expect(btn.classList.contains('active')).toBe(false); // spins by default
    btn.click();
    expect(calls).toBe(1);
    hud.setFreezeSpinActive(true);
    expect(btn.classList.contains('active')).toBe(true);
    hud.setFreezeSpinActive(false);
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('ocean toggles fire their callbacks and start active', () => {
    const root = document.createElement('div');
    let waves = 0;
    let glint = 0;
    buildHud(root, '42', { ...noop, onWaves: () => { waves++; }, onGlint: () => { glint++; } });
    const wavesBtn = root.querySelector('button[name="waves-toggle"]') as HTMLButtonElement;
    const glintBtn = root.querySelector('button[name="glint-toggle"]') as HTMLButtonElement;
    // Both default to on (the ocean material defaults), reflected in the class.
    expect(wavesBtn.classList.contains('active')).toBe(true);
    expect(glintBtn.classList.contains('active')).toBe(true);
    wavesBtn.click();
    glintBtn.click();
    expect(waves).toBe(1);
    expect(glint).toBe(1);
  });

  it('night-fill toggle fires onNightFill and starts off (dark terminator)', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onNightFill: () => { calls++; } });
    const btn = root.querySelector('button[name="night-fill-toggle"]') as HTMLButtonElement;
    expect(btn.classList.contains('active')).toBe(false); // honest dark night by default
    btn.click();
    expect(calls).toBe(1);
    hud.setNightFillActive(true);
    expect(btn.classList.contains('active')).toBe(true);
  });

  it('setWavesActive / setGlintActive toggle their active class independently', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const wavesBtn = root.querySelector('button[name="waves-toggle"]') as HTMLButtonElement;
    const glintBtn = root.querySelector('button[name="glint-toggle"]') as HTMLButtonElement;
    hud.setWavesActive(false);
    expect(wavesBtn.classList.contains('active')).toBe(false);
    expect(glintBtn.classList.contains('active')).toBe(true); // untouched
    hud.setGlintActive(false);
    expect(glintBtn.classList.contains('active')).toBe(false);
  });
});
