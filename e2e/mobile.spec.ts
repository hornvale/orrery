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

  // Every tab is reachable, and every visible control clears the touch target.
  for (const tab of ['lens', 'look', 'layers', 'time']) {
    await page.locator(`.sheet-tab[data-tab="${tab}"]`).click();
    await expect(page.locator(`.sheet-tab[data-tab="${tab}"]`)).toHaveClass(/active/);

    const targets = page.locator(
      '.sheet-body button, .sheet-body input[type="range"], .sheet-tab, .transport button, .rung',
    );
    const n = await targets.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const box = await targets.nth(i).boundingBox();
      if (!box) continue; // not laid out (inside a collapsed group)
      expect
        .soft(box.height, `control ${i} on the ${tab} tab is too short`)
        .toBeGreaterThanOrEqual(TAP - 1); // -1 for sub-pixel layout rounding
    }
  }

  // The transport stays on screen with the sheet open — it must not slide
  // under the home indicator.
  const play = await page.locator('[data-transport="play"]').boundingBox();
  const viewport = page.viewportSize()!;
  expect(play).not.toBeNull();
  expect(play!.y + play!.height).toBeLessThanOrEqual(viewport.height);
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
