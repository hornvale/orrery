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

  // `setDate` is the clock's write path, called every unpaused animation
  // frame (main.ts's `updateDateLine`). Without a guard it would overwrite
  // whatever the viewer is mid-typing on the very next frame — unusable
  // during playback, which is the moment a jump is most wanted. "Being
  // edited" is a dirty flag, not focus: a viewer can focus the field and
  // walk away without typing, and that must still resume tracking rather
  // than freeze the field forever. The flag goes dirty on a real `input`
  // event, and clean again on a successful submit (the edit is now spent).
  //
  // Blur WITHOUT a submit is treated as abandonment, not "still editing
  // elsewhere": it clears `dirty` unconditionally and restores the input to
  // `liveValue` immediately. An "only if unchanged" rule was tried first and
  // rejected — `liveValue` moves with the clock on every `setDate` call
  // regardless of `dirty`, so a genuinely edited value would almost never
  // coincide with it again, leaving the field dirty (and therefore frozen,
  // silently, for the rest of the session) forever. Discarding on blur is
  // honest instead: the viewer's abandoned text is visibly replaced by the
  // real date, and there is no silent-freeze path left to trigger.
  let dirty = false;
  let liveValue = ''; // the clock's current text, kept current every `setDate` call regardless of `dirty`

  // A real activation of `go` blurs the input BEFORE the activation itself
  // completes, on every input method: mouse is pointerdown -> mousedown ->
  // blur -> ... -> click; touch is pointerdown -> touchstart -> blur (iOS
  // blurs on touchstart, before the synthetic mousedown compat event) ->
  // ... -> click; keyboard-Tab is blur (leaving the input) -> focus (landing
  // on `go`) ->, arbitrarily later, Enter/Space -> click. In every case the
  // blur handler below would discard the typed text as "abandoned" before
  // `submit` ever runs. Fighting the blur itself (e.g. `preventDefault` on
  // `go`'s `mousedown`) only covers the mouse case — iOS's blur-on-touchstart
  // fires before any mousedown compat event exists to prevent, and Space/
  // Enter after a Tab is pure keyboard, no pointer event at all.
  //
  // So this does not fight focus: it snapshots the being-typed text into
  // `pendingSubmitValue` at the earliest moment common to all three paths
  // (mouse/touch: `go`'s own `pointerdown`, which precedes blur on every
  // platform; keyboard: the blur itself, since Tab-to-Go has no pointerdown
  // to hook), and `submit` prefers that snapshot over the input's own
  // (possibly already-reset) value. A fresh `input` event invalidates a
  // stale snapshot — the viewer has started over, so the old abandoned text
  // must not resurface on a later, unrelated `go` activation.
  let pendingSubmitValue: string | null = null;
  const snapshotPending = (): void => {
    if (dirty) pendingSubmitValue = input.value;
  };

  function submit(): void {
    const raw = pendingSubmitValue ?? input.value;
    pendingSubmitValue = null;
    const parsed = parseDateEntry(raw);
    if (!parsed) {
      element.classList.add('invalid');
      return;
    }
    element.classList.remove('invalid');
    dirty = false;
    cb.onJump(parsed.year, parsed.dayOfYear);
  }

  go.addEventListener('pointerdown', snapshotPending);
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.addEventListener('input', () => {
    dirty = true;
    pendingSubmitValue = null; // a fresh edit outranks any earlier handoff
  });
  input.addEventListener('blur', () => {
    snapshotPending(); // preserve a Tab-to-Go (or touchstart-blur) handoff
    dirty = false;
    input.value = liveValue;
    element.classList.remove('invalid');
  });

  row.append(input, go);
  element.append(label, row);

  return {
    element,
    setDate: (year, dayOfYear) => {
      liveValue = `${year} ${dayOfYear}`;
      if (dirty) return; // an edit is in progress — do not clobber it
      input.value = liveValue;
      element.classList.remove('invalid');
      // Normal clock-tracking resumed, so any earlier abandoned-edit
      // snapshot is now stale — without this, a `go` tap with nothing
      // freshly typed (rare, but possible right after an abandonment) could
      // resubmit old text instead of doing nothing useful with the current
      // value.
      pendingSubmitValue = null;
    },
  };
}
