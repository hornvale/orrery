import { describe, expect, it } from 'vitest';
import { buildDateField, parseDateEntry } from './dateField';
import { dayToRawDate, rawDateToDay } from '../time/calendar';

describe('parseDateEntry', () => {
  it('reads a year and a day separated by a space', () => {
    expect(parseDateEntry('3 214')).toEqual({ year: 3, dayOfYear: 214 });
  });

  it('accepts a slash, a comma, or the Y/d prefixes a viewer might copy from the status bar', () => {
    expect(parseDateEntry('3/214')).toEqual({ year: 3, dayOfYear: 214 });
    expect(parseDateEntry('3, 214')).toEqual({ year: 3, dayOfYear: 214 });
    expect(parseDateEntry('Y3 d214')).toEqual({ year: 3, dayOfYear: 214 });
    expect(parseDateEntry('  Year 3, day 214 ')).toEqual({ year: 3, dayOfYear: 214 });
  });

  it('defaults the day to 1 when only a year is given', () => {
    expect(parseDateEntry('412')).toEqual({ year: 412, dayOfYear: 1 });
  });

  it('rejects junk rather than guessing', () => {
    expect(parseDateEntry('')).toBeNull();
    expect(parseDateEntry('soon')).toBeNull();
    expect(parseDateEntry('Y')).toBeNull();
  });

  it('rejects a year or day below 1 — the UI is 1-based', () => {
    expect(parseDateEntry('0 5')).toBeNull();
    expect(parseDateEntry('3 0')).toBeNull();
    expect(parseDateEntry('-2 5')).toBeNull();
  });

  it('floors a fractional entry rather than rejecting it', () => {
    expect(parseDateEntry('3 214.7')).toEqual({ year: 3, dayOfYear: 214 });
  });
});

describe('the date field', () => {
  it('reports a parsed jump', () => {
    let got: [number, number] | null = null;
    const f = buildDateField({ onJump: (y, d) => { got = [y, d]; } });
    const input = f.element.querySelector('input') as HTMLInputElement;
    input.value = '412 3';
    (f.element.querySelector('[data-date="go"]') as HTMLButtonElement).click();
    expect(got).toEqual([412, 3]);
  });

  it('submits on Enter as well as the button', () => {
    let got: [number, number] | null = null;
    const f = buildDateField({ onJump: (y, d) => { got = [y, d]; } });
    const input = f.element.querySelector('input') as HTMLInputElement;
    input.value = '7 8';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(got).toEqual([7, 8]);
  });

  it('does not fire and marks itself invalid on junk', () => {
    let fired = 0;
    const f = buildDateField({ onJump: () => { fired++; } });
    const input = f.element.querySelector('input') as HTMLInputElement;
    input.value = 'nonsense';
    (f.element.querySelector('[data-date="go"]') as HTMLButtonElement).click();
    expect(fired).toBe(0);
    expect(f.element.classList.contains('invalid')).toBe(true);
  });

  it('a real blur-before-click handoff (Tab-to-Go, or iOS blurring on touchstart) still submits what was typed, not the discarded value', () => {
    // A real activation of `go` blurs the input BEFORE the click fires — on
    // touch, iOS blurs on `touchstart`, before the synthetic `mousedown`
    // even exists; on keyboard, Tab-to-Go blurs long before Enter/Space.
    // `.click()` alone (as the other tests here use) never exercises this —
    // it fires a bare `click`, no blur — so this drives the blur explicitly
    // to prove the value survives it.
    let got: [number, number] | null = null;
    const f = buildDateField({ onJump: (y, d) => { got = [y, d]; } });
    const input = f.element.querySelector('input') as HTMLInputElement;
    const go = f.element.querySelector('[data-date="go"]') as HTMLButtonElement;
    input.value = '5 30';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur')); // the handoff: the visible field already resets here
    expect(input.value).not.toBe('5 30');
    go.click();
    expect(got).toEqual([5, 30]);
  });

  it('a fresh edit after an abandoned one submits the NEW text, not the stale handoff', () => {
    let got: [number, number] | null = null;
    const f = buildDateField({ onJump: (y, d) => { got = [y, d]; } });
    const input = f.element.querySelector('input') as HTMLInputElement;
    const go = f.element.querySelector('[data-date="go"]') as HTMLButtonElement;
    input.value = '5 30';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur')); // abandoned — '5 30' becomes a pending handoff
    input.value = '7 8'; // the viewer starts over
    input.dispatchEvent(new Event('input')); // must drop the stale '5 30' handoff
    go.click();
    expect(got).toEqual([7, 8]);
  });

  it('clears the invalid mark once a good value is entered', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    const go = f.element.querySelector('[data-date="go"]') as HTMLButtonElement;
    input.value = 'nonsense';
    go.click();
    input.value = '3 214';
    go.click();
    expect(f.element.classList.contains('invalid')).toBe(false);
  });

  it('setDate fills the input without firing onJump', () => {
    let fired = 0;
    const f = buildDateField({ onJump: () => { fired++; } });
    f.setDate(3, 214);
    expect((f.element.querySelector('input') as HTMLInputElement).value).toBe('3 214');
    expect(fired).toBe(0);
  });
});

// The clock calls `setDate` every unpaused animation frame (via
// `updateDateLine`). Without a guard, that clobbers whatever the viewer is
// mid-typing on the very next frame — the field would be unusable during
// playback, which is precisely when a jump is most likely wanted. "Being
// edited" is defined as: dirty since the last real `input` event, and NOT
// dirty once a submit succeeds. Focus alone does not count — a viewer can
// focus and walk away without typing, and that must resume tracking, not
// freeze the field forever. Blurring WITHOUT submitting is abandonment: the
// dirty flag clears unconditionally and the input is restored to the
// clock's current value right then, rather than waiting for a coincidence
// (edited text happening to match the still-moving clock) that would in
// practice never arrive and would otherwise freeze the field silently.
describe('setDate does not clobber an edit in progress', () => {
  it('does NOT change the value while the viewer has typed something', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    input.value = '99 1';
    input.dispatchEvent(new Event('input'));
    f.setDate(3, 214);
    expect(input.value).toBe('99 1');
  });

  it('DOES update an untouched field — the normal clock-tracking path', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    f.setDate(3, 214);
    expect(input.value).toBe('3 214');
  });

  it('resumes tracking after a successful submit', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    const go = f.element.querySelector('[data-date="go"]') as HTMLButtonElement;
    input.value = '5 6';
    input.dispatchEvent(new Event('input'));
    go.click();
    f.setDate(9, 10);
    expect(input.value).toBe('9 10');
  });

  it('does NOT resume tracking on a failed submit — the junk stays put for correction', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    const go = f.element.querySelector('[data-date="go"]') as HTMLButtonElement;
    input.value = 'nonsense';
    input.dispatchEvent(new Event('input'));
    go.click();
    f.setDate(3, 214);
    expect(input.value).toBe('nonsense');
  });

  it('treats an unsubmitted blur as abandonment: resumes tracking and shows the clock value, not the abandoned text', () => {
    const f = buildDateField({ onJump: () => {} });
    const input = f.element.querySelector('input') as HTMLInputElement;
    f.setDate(3, 214); // the clock currently reads Y3/D214
    input.value = '99 1';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    // The abandoned text is replaced immediately on blur, not left frozen —
    // this is the honest-feedback half of the fix.
    expect(input.value).toBe('3 214');
    // And ordinary clock-tracking resumes on the next tick.
    f.setDate(9, 10);
    expect(input.value).toBe('9 10');
  });
});

// `main.ts` is not importable from a test (it boots the whole app on import),
// so the 1-based-in/0-based-to-the-engine conversion that its `jumpToDate`
// performs — `rawDateToDay(year - 1, dayOfYear - 1, yearDays)`, verbatim from
// the old HUD's `onDateJump` — is pinned here instead, composing this file's
// parser with the real `time/calendar` functions main.ts calls. An off-by-one
// in that composition would land the viewer on the wrong day silently; this
// is the test that would catch it.
describe('the 1-based field to 0-based engine conversion (mirrors main.ts jumpToDate)', () => {
  it('"3 214" (1-based) lands on the engine day whose 0-based split reads back as year 3, day 214', () => {
    const yearDays = 360;
    const parsed = parseDateEntry('3 214');
    expect(parsed).not.toBeNull();
    const { year, dayOfYear } = parsed!;
    const day = rawDateToDay(year - 1, dayOfYear - 1, yearDays);
    const back = dayToRawDate(day, yearDays);
    expect(back.year + 1).toBe(3);
    expect(back.dayOfYear + 1).toBe(214);
  });

  it('a bare "412" (day defaults to 1) lands exactly on the first day of year 412', () => {
    const yearDays = 360;
    const parsed = parseDateEntry('412');
    expect(parsed).not.toBeNull();
    const { year, dayOfYear } = parsed!;
    const day = rawDateToDay(year - 1, dayOfYear - 1, yearDays);
    expect(day).toBe(411 * yearDays); // year 412 (1-based) is index 411 (0-based)
    const back = dayToRawDate(day, yearDays);
    expect(back.year + 1).toBe(412);
    expect(back.dayOfYear + 1).toBe(1);
  });

  it('year 1, day 1 — the earliest reachable date — lands on engine day 0', () => {
    const yearDays = 360;
    const parsed = parseDateEntry('1 1');
    expect(parsed).not.toBeNull();
    const { year, dayOfYear } = parsed!;
    expect(rawDateToDay(year - 1, dayOfYear - 1, yearDays)).toBe(0);
  });
});
