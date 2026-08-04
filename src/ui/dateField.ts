/** Jump to a date. BESPOKE chrome, not a registry control — a third exception
 * alongside the day scrubber and the info card (Console spec §1).
 *
 * Text entry needs parsing, validation, and an invalid state, none of which
 * the four control kinds model. Inventing a `text` kind for one consumer would
 * cost more than admitting the exception.
 *
 * Why it exists at all: the scrubber only moves within ONE year, so without
 * this there is no way to reach year 412. */

/** Parse a viewer's date entry. 1-based in, 1-based out — the caller converts
 * to the engine's 0-based form, exactly as the old HUD's jump button did.
 *
 * Deliberately lenient about separators and prefixes so that text copied
 * straight out of the status bar ("Year 3, day 214") round-trips. Deliberately
 * strict about everything else: junk returns null rather than a guess, because
 * silently jumping somewhere unintended is worse than refusing. */
export function parseDateEntry(raw: string): { year: number; dayOfYear: number } | null {
  const nums = raw.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  // A leading minus is never a separator we accept, so reject it explicitly —
  // the digit scan above would otherwise read "-2 5" as year 2.
  if (/-\s*\d/.test(raw)) return null;
  const year = Math.floor(Number(nums[0]));
  const dayOfYear = nums.length > 1 ? Math.floor(Number(nums[1])) : 1;
  if (!Number.isFinite(year) || !Number.isFinite(dayOfYear)) return null;
  if (year < 1 || dayOfYear < 1) return null;
  return { year, dayOfYear };
}

export interface DateField {
  element: HTMLElement;
  /** Reflect the current date without firing `onJump` — the clock driving the
   * UI, not the viewer typing into it. Mirrors the transport's `setDay`. */
  setDate(year: number, dayOfYear: number): void;
}

export function buildDateField(cb: { onJump(year: number, dayOfYear: number): void }): DateField {
  const element = document.createElement('div');
  element.className = 'date-field';

  const label = document.createElement('div');
  label.className = 'control-label';
  label.textContent = 'Go to';

  const row = document.createElement('div');
  row.className = 'date-field-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.name = 'date-entry';
  input.inputMode = 'numeric';
  input.placeholder = 'year day';
  input.setAttribute('aria-label', 'jump to year and day');

  const go = document.createElement('button');
  go.className = 'date-go';
  go.dataset.date = 'go';
  go.textContent = 'Go';

  function submit(): void {
    const parsed = parseDateEntry(input.value);
    if (!parsed) {
      element.classList.add('invalid');
      return;
    }
    element.classList.remove('invalid');
    cb.onJump(parsed.year, parsed.dayOfYear);
  }

  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  row.append(input, go);
  element.append(label, row);

  return {
    element,
    setDate: (year, dayOfYear) => {
      input.value = `${year} ${dayOfYear}`;
      element.classList.remove('invalid');
    },
  };
}
