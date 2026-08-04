import { devices, expect, test, type Page } from '@playwright/test';

/** Minimum touch target height (px), per accessibility guidance for a
 * tappable control — the floor Task 9's mobile-first stylesheet is meant to
 * clear on every tab, not just the one a reviewer happened to screenshot. */
const TAP = 44;

/** Everything a phone viewport must get right, regardless of exact width:
 * no sideways scroll, every tab reachable, every visible control clears the
 * touch-target floor, and the transport never slides under the home
 * indicator. Shared by both widths below so a fix (or a regression) shows up
 * identically at both, rather than one spec silently drifting from the
 * other. */
async function assertUsableOnPhone(page: Page): Promise<void> {
  // No leading slash: `baseURL` already carries the `/orrery/` sub-path
  // (playwright.config.ts — the production shape, base-path 404s are exactly
  // what this config exists to catch), and a leading `/` resolves against
  // the ORIGIN instead, dropping that sub-path. Every other spec's `goto`
  // is relative for the same reason; this one wasn't, and the console
  // silently never loaded.
  await page.goto('#seed=42');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  // The page never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Every tab is reachable, and every visible control clears the touch
  // target. `.transport > button` (direct children only — play/rate), NOT
  // `.transport button`: the eclipse marks are also `<button>`s, but nested
  // two levels deeper (`.transport-track > .eclipse-marks > button`), and
  // they are `pointer-events: none` (styles.css) — a real tap/drag never
  // lands on one at all, always on the scrubber underneath (see the
  // dedicated eclipse-mark checks below for why, and for what a real pointer
  // interaction does instead). Sweeping them into this generic box-height
  // check would both mismeasure a deliberately-decorative element and (a
  // seed can pack several marks a few px apart) blow this loop's own time
  // budget one mark at a time.
  for (const tab of ['lens', 'look', 'layers', 'time']) {
    await page.locator(`.sheet-tab[data-tab="${tab}"]`).click();
    await expect(page.locator(`.sheet-tab[data-tab="${tab}"]`)).toHaveClass(/active/);

    // A single batched read (one round trip), not one `boundingBox()` await
    // per control — N round trips is what blew this spec's time budget once
    // a tab's targets included a whole cluster of eclipse marks.
    const boxes = await page
      .locator('.sheet-body button, .sheet-body input[type="range"], .sheet-tab, .transport > button, .rung')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return r.width === 0 && r.height === 0 ? null : { height: r.height };
        }),
      );
    expect(boxes.length).toBeGreaterThan(0);
    boxes.forEach((box, i) => {
      if (!box) return; // not laid out (inside a collapsed group)
      expect
        .soft(box.height, `control ${i} on the ${tab} tab is too short`)
        .toBeGreaterThanOrEqual(TAP - 1); // -1 for sub-pixel layout rounding
    });
  }

  // The transport stays on screen with the sheet open — it must not slide
  // under the home indicator.
  const play = await page.locator('[data-transport="play"]').boundingBox();
  const viewport = page.viewportSize()!;
  expect(play).not.toBeNull();
  expect(play!.y + play!.height).toBeLessThanOrEqual(viewport.height);

  // The eclipse marks' round-2 fix, checked live in a real browser rather
  // than reasoned about: a DRAG started exactly on a mark's own position
  // must still move the scrubber. Round 1's enlarged CSS hit-box passed the
  // touch-target floor but, centered on the same point as the slider
  // underneath, shadowed a chunk of its drag surface through a dense
  // cluster — a real regression this asserts against directly, on seed 42's
  // actual dense solar/lunar cluster (days 86–119), not a synthetic one.
  const scrub = page.locator('.transport-track input[type="range"]');
  const clusterMark = page.locator('.eclipse-mark').first(); // seed 42: day 86, inside the dense cluster
  const markBox = await clusterMark.boundingBox();
  expect(markBox, 'expected at least one eclipse mark for seed 42').not.toBeNull();
  if (markBox) {
    const before = await scrub.inputValue();
    const startX = markBox.x + markBox.width / 2;
    const startY = markBox.y + markBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 8 }); // a real drag: well past TAP_MOVE_PX
    await page.mouse.up();
    const after = await scrub.inputValue();
    expect(after, 'a drag started on a mark must still scrub — the mark must not have eaten it').not.toBe(before);
  }

  // The flip side: a TAP (no drag) at that same spot must still resolve to
  // AN eclipse mark's card — `pointer-events: none` moved the interaction
  // onto the scrubber, but transport.ts's own pointerdown/pointerup
  // hit-test is what's supposed to recover tappability there. This does not
  // prove every mark in the cluster is independently reachable (nearest-wins
  // is deterministic, but seed 42 has no fully isolated mark to demonstrate
  // that against in THIS world) — the unit tests in transport.test.ts pin
  // the nearest-wins math directly; this only proves tapping the cluster at
  // all still surfaces a card, i.e. constraint (a) — comfortably tappable —
  // actually holds live, not just by construction.
  if (markBox) {
    const cx = markBox.x + markBox.width / 2;
    const cy = markBox.y + markBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up(); // no movement, no hold — a tap
    await expect(page.locator('.info-card')).toContainText('eclipse', { timeout: 2_000 });
    await page.keyboard.press('Escape');
  }
}

// The device preset (touch, mobile UA, `defaultBrowserType`) is a worker-level
// fixture and must be set at the top of the FILE — `test.use` inside a
// `describe` for it forces a new worker and Playwright refuses it. Only the
// two describes below differ, and only in `viewport`, which IS a per-test
// fixture and free to override per describe.
//
// `defaultBrowserType` is overridden back to `chromium`: the iPhone preset
// asks for webkit, but this repo only installs chromium (CLAUDE.md's `npx
// playwright install chromium`) — installing a second browser engine just to
// emulate a viewport would be a new local/CI dependency for no coverage this
// spec actually needs (touch/viewport/UA emulation all work under chromium).
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

// iPhone 13 — a common, roomier modern viewport (390px).
test.describe('iPhone 13 (390px)', () => {
  test('the console is usable at an iPhone viewport', async ({ page }) => {
    await assertUsableOnPhone(page);
  });
});

// iPhone SE / mini — the narrowest common iPhone viewport (375px). A
// reviewer's arithmetic once put the status bar at ~383px of content against
// a 375px viewport: measured passing at 390px but thin, and wrong at the
// real floor. 375px is that floor, so it gets its own pass rather than being
// assumed to follow from the 390px result.
test.describe('iPhone SE / mini (375px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the console is usable at the narrowest common iPhone viewport (375px)', async ({ page }) => {
    await assertUsableOnPhone(page);
  });
});
