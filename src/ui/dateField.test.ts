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
