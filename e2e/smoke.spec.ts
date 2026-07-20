import { expect, test } from '@playwright/test';

test('seed 42 boots, renders, and stays console-clean', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42');
  // Genesis runs in-browser and takes seconds; the HUD only mounts after.
  await expect(page.locator('.hud-top-left')).toContainText('seed 42', { timeout: 150_000 });
  await expect(page.locator('canvas.view-canvas')).toHaveCount(2);
  await expect(page.locator('.scale-caption')).toContainText('schematic scale');

  // The view toggle is the zoom ladder's discrete control.
  await page.getByRole('button', { name: /view: globe/ }).click();
  await expect(page.locator('.scale-caption')).toContainText('relief is exaggerated', { timeout: 10_000 });

  expect(errors).toEqual([]);
});

test('the helm: true scale, inspector, and the capped globe clock', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe');
  await expect(page.locator('.hud-top-left')).toContainText('seed 42', { timeout: 150_000 });

  // Per-rung clock: the globe defaults to 1 hr/s, and since The Wandering Sun
  // the fast rates are offered there — picking one freezes the diurnal spin so
  // a year can be watched (the caption says so) rather than blurring the planet.
  await expect(page.getByRole('button', { name: '1 hr/s' })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '~1 mo/s' })).toBeEnabled();
  await page.getByRole('button', { name: '~1 mo/s' }).click();
  await expect(page.locator('.scale-caption')).toContainText('holding the daily spin');

  // True scale flips the caption to the honest variant, and the label back.
  await page.getByRole('button', { name: 'true scale' }).click();
  await expect(page.locator('.scale-caption')).toContainText('true scale');
  await page.getByRole('button', { name: 'schematic scale' }).click();

  // The inspector: the globe fills the viewport center — clicking it is a
  // world card, deterministically.
  await page.locator('canvas.view-canvas').last().click({ position: { x: 640, y: 360 } });
  await expect(page.locator('.info-card')).toContainText('the world');
  await page.keyboard.press('Escape');
  await expect(page.locator('.info-card')).toBeHidden();

  expect(errors).toEqual([]);
});

test('the lens roster: every lens repaints the globe and updates its own caption', async ({ page }) => {
  // Genesis's own wait already claims up to 150s of the global 180s test
  // timeout; the rotation + six lens clicks that follow need their own
  // room rather than racing what genesis left behind.
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('.hud-top-left')).toContainText('seed 42', { timeout: 150_000 });

  const globeCanvas = page.locator('canvas.view-canvas').last();
  const caption = page.locator('.hud-caption');

  // Pause the clock: left running, the day keeps advancing for the whole
  // rest of this test, and under real (variable) system load that can spin
  // the world through several full rotations between one lens capture and
  // the next — enough to land two DIFFERENT lenses both on the fully dark
  // night side, where they'd render byte-identical black frames without
  // either lens actually being broken. A fixed day makes the comparison
  // depend only on the lens, not on how fast this happened to run.
  await page.locator('.hud-bottom button').first().click();

  // `natural` and `topographic` share one code path over OCEAN tiles
  // (both call the same elevationColor) and only diverge over land — so a
  // camera framing that happens to show pure ocean would make that pair
  // look identical without either lens actually being broken. Rotate to a
  // framing with land in view before comparing, the same way the sky can
  // be all-night at boot: a default camera angle is not a legibility
  // guarantee.
  const box = (await globeCanvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 150, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  // A cheap non-blank + non-identical check: Playwright's own element
  // screenshot (a compositor-level capture), not `canvas.toDataURL()` —
  // this renderer's WebGL context isn't `preserveDrawingBuffer`, so a
  // `toDataURL()` read from a separate `evaluate()` call can race the next
  // frame's clear and silently read back an empty buffer regardless of
  // which lens is active. Not a golden-image pixel-diff (no stored
  // reference, no threshold tuning) — just "this frame isn't empty and
  // isn't the frame from before the click."
  async function fingerprint(): Promise<Buffer> {
    return globeCanvas.screenshot();
  }

  // `natural` is already the default lens at mount (main.ts wires it up
  // before the first frame), so click it explicitly to fix a baseline
  // rather than diffing the first iteration against mount state — clicking
  // an already-active lens is a real no-op and must NOT look like a failure.
  await page.locator('.hud-lenses button', { hasText: 'natural' }).click();
  await page.waitForTimeout(150);
  const baselineShot = await fingerprint();
  const baselineCaption = await caption.textContent();
  // A blank/transparent canvas still yields a short but non-trivial PNG —
  // a rendered scene's is far longer.
  expect(baselineShot.length).toBeGreaterThan(5_000);
  expect(baselineCaption).not.toBe('');

  for (const label of ['topographic', 'temperature', 'moisture', 'precip', 'unrest', 'plates']) {
    await page.locator('.hud-lenses button', { hasText: label }).click();
    await expect(globeCanvas).toBeVisible();
    // Let the repaint land before sampling.
    await page.waitForTimeout(150);

    const shot = await fingerprint();
    const captionText = await caption.textContent();

    expect(shot.length).toBeGreaterThan(5_000);
    expect(shot.equals(baselineShot)).toBe(false);
    expect(captionText).not.toBe(baselineCaption);
    expect(captionText).not.toBe('');
  }

  expect(errors).toEqual([]);
});

test('the style roster: every render style renders the globe non-blank and transformed', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('.hud-top-left')).toContainText('seed 42', { timeout: 150_000 });

  const globeCanvas = page.locator('canvas.view-canvas').last();
  // Pause the clock (same reason as the lens roster: a running day can drift two
  // captures onto the dark night side and make them byte-identical black frames).
  await page.locator('.hud-bottom button').first().click();
  // Rotate to bring land into view so the styles have real relief/colour to act on.
  const box = (await globeCanvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 150, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  // A style shader that fails to compile (e.g. a GLSL reserved-word variable)
  // renders the whole globe black — a very short, highly-compressible PNG. The
  // >5000-byte non-blank check catches that; the not-equal-to-photoreal check
  // confirms the style actually transformed the frame.
  const styleButtons = page.locator('[data-style]');
  expect(await styleButtons.count()).toBeGreaterThanOrEqual(5);

  await page.locator('[data-style="photoreal"]').click();
  await page.waitForTimeout(250);
  const photoreal = await globeCanvas.screenshot();
  expect(photoreal.length).toBeGreaterThan(5_000);

  for (const id of ['pixel-art', 'cel', 'engraving', 'watercolor']) {
    await page.locator(`[data-style="${id}"]`).click();
    await expect(globeCanvas).toBeVisible();
    await page.waitForTimeout(300);
    const shot = await globeCanvas.screenshot();
    expect(shot.length, `${id} rendered blank`).toBeGreaterThan(5_000);
    expect(shot.equals(photoreal), `${id} did not transform the frame`).toBe(false);
  }

  expect(errors).toEqual([]);
});
