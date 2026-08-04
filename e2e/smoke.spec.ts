import { expect, test, type Page } from '@playwright/test';

/** Wait until the globe has actually finished building, rather than sleeping a
 * fixed number of milliseconds and hoping.
 *
 * The Cascade made every whole-globe rebuild AMORTIZED: `setStyle`,
 * `setTrueRelief`, the initial base mount and every LOD refine only ENQUEUE,
 * and `drainBuildQueue` builds at most `MAX_BUILDS_PER_FRAME` (6) tiles per
 * frame. The base set is 6·4² = 96 tiles, so a style switch needs ~16 frames —
 * fine at 60 fps, not fine on a loaded box under software WebGL. Any fixed
 * sleep here is therefore a bet on frame rate, and raising the number only
 * moves the threshold the bet loses at.
 *
 * `globalThis.__buildPending` (globe.ts, alongside `__btCount`/`__swapCount`/
 * `__slotBuildCount`) is the build queue's depth, written at both enqueue sites
 * and at the drain — so it is already non-zero when the call that enqueued
 * returns, and reaching 0 means every tile the current leaf set wants is
 * mounted.
 *
 * Used only where an assertion actually DEPENDS on the rebuild having landed
 * (the geometry-style roster, the voxel switch before the deep zoom, the two
 * roster baselines that later shots are diffed against, and the helm's
 * inspector click — a raycast can only hit a tile that is MOUNTED, so a click
 * during the boot drain picks empty space). The boot sleeps in
 * the map/vantage tests are left as sleeps on purpose: those tests assert on
 * the map canvas and on crossfade opacities, never on globe tiles, so making
 * them block on a full 96-tile drain would buy no correctness and cost every
 * one of them a real minute on a loaded box.
 *
 * Strictly `=== 0` (`undefined` → `-1`): before the globe view exists the hook
 * is absent, and treating that as ready would reintroduce the very false-pass
 * this replaces. The trailing double-rAF then guarantees one frame has been
 * RENDERED with the finished set — which also covers a re-select of the
 * SAME style, which legitimately enqueues nothing at all. (Task 2 deleted
 * `faceted`, the one style that used to cross no geometry family; every
 * remaining style switch now enqueues a rebuild.)
 *
 * `expect.poll`, not `waitForFunction`, on purpose: when it does give up, the
 * failure reads `expected 0, received 37` — which distinguishes "the box is
 * slow, it was still draining" from "the queue is wedged" without a rerun.
 * Measured on a quiet-ish box, the boot drain (96 tiles) takes ~14 s and then
 * sits at 0; the timeout is a generous multiple of that, and the wait costs
 * only as many frames as the rebuild actually needs. */
async function waitForGlobeIdle(
  page: import('@playwright/test').Page,
  timeoutMs = 90_000,
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (globalThis as { __buildPending?: number }).__buildPending ?? -1), {
      timeout: timeoutMs,
      message: 'the globe build queue never drained',
    })
    .toBe(0);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Navigates to `hash` and waits for the seed to render — every spec's boot
 * wait, in one place. The seed is the console's only always-on-screen text,
 * so it's the one thing every spec can wait on regardless of which rung it
 * boots into. */
async function bootSeed42(page: Page, hash = '#seed=42'): Promise<void> {
  await page.goto(hash);
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
}

/** Opens the sheet tab that holds `group`, then returns the control's own
 * root (`[data-control="<id>"]`) — every control now lives behind a tab, so
 * reaching one is a click-then-locate rather than a bare locate. */
async function control(page: Page, group: string, id: string) {
  await page.locator(`.sheet-tab[data-tab="${group}"]`).click();
  return page.locator(`[data-control="${id}"]`);
}

test('seed 42 boots, renders, and stays console-clean', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42');
  // Genesis runs in-browser and takes seconds; the console only mounts after.
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await expect(page.locator('canvas.view-canvas')).toHaveCount(3); // system, globe, map
  await expect(page.locator('.scale-caption')).toContainText('schematic scale');

  // The Vantage: view switching is explicit via the status bar's rung buttons.
  await page.locator('.rung[data-rung="globe"]').click();
  await expect(page.locator('.scale-caption')).toContainText('relief is exaggerated', { timeout: 10_000 });

  expect(errors).toEqual([]);
});

test('the helm: true scale, inspector, and the capped globe clock', async ({ page }) => {
  // Genesis's 150s allowance plus a full base-set mount before the inspector
  // click no longer fits the 180s default.
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  // Per-rung clock: the globe defaults to 1 hr/s, and since The Wandering Sun
  // the fast rates are offered there — picking one freezes the diurnal spin so
  // a year can be watched (the caption says so) rather than blurring the planet.
  // The rate picker lives in the Time tab now. Scoped to the control's own
  // root, not `page` — the transport's read-only rate chip (`.transport-rate`)
  // shows the SAME label text ("1 hr/s") outside the sheet, so an unscoped
  // `getByRole` resolves to both and Playwright's strict mode rejects it.
  const rate = await control(page, 'time', 'rate');
  await expect(rate.getByRole('button', { name: '1 hr/s' })).toHaveClass(/active/);
  await expect(rate.getByRole('button', { name: '~1 mo/s' })).toBeEnabled();
  await rate.getByRole('button', { name: '~1 mo/s' }).click();
  await expect(page.locator('.scale-caption')).toContainText('holding the daily spin');

  // True scale flips the caption to the honest variant, and the label back.
  // The old single "true scale" toggle is now the `relief` control's option
  // pair (Look tab): `true` / `×${RELIEF_EXAGGERATION}` (schematic).
  const relief = await control(page, 'look', 'relief');
  await relief.locator('[data-option="true"]').click();
  await expect(page.locator('.scale-caption')).toContainText('true scale');
  await relief.locator('[data-option="schematic"]').click();

  // The inspector: the globe fills the viewport center — clicking it is a
  // world card, deterministically. The raycast can only hit a MOUNTED tile,
  // and the base set arrives over frames, so this waits on the queue rather
  // than on luck: measured under a 6x CPU throttle, the click landed with 92
  // of 96 tiles still unbuilt and picked empty space (the card stayed ""),
  // which is precisely how this read on CI.
  await waitForGlobeIdle(page);
  await page.locator('canvas.view-canvas').nth(1).click({ position: { x: 640, y: 360 } });
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
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  const globeCanvas = page.locator('canvas.view-canvas').nth(1);
  const caption = page.locator('[data-control="lens"] .control-help');

  // Pause the clock: left running, the day keeps advancing for the whole
  // rest of this test, and under real (variable) system load that can spin
  // the world through several full rotations between one lens capture and
  // the next — enough to land two DIFFERENT lenses both on the fully dark
  // night side, where they'd render byte-identical black frames without
  // either lens actually being broken. A fixed day makes the comparison
  // depend only on the lens, not on how fast this happened to run.
  await page.locator('[data-transport="play"]').click();

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
  const lens = await control(page, 'lens', 'lens');
  await lens.locator('[data-option="natural"]').click();
  // The amortized base mount and the refines the rotation above queued must
  // both have landed before the baseline is fixed — otherwise the baseline is
  // a half-built globe and every later diff is against the wrong picture.
  // (The 150ms waits elsewhere in this test are compositor settle for a lens
  // REPAINT, which `setLens` still does synchronously — a different thing.)
  await waitForGlobeIdle(page);
  await page.waitForTimeout(150);
  const baselineShot = await fingerprint();
  const baselineCaption = await caption.textContent();
  // A blank/transparent canvas still yields a short but non-trivial PNG —
  // a rendered scene's is far longer.
  expect(baselineShot.length).toBeGreaterThan(5_000);
  expect(baselineCaption).not.toBe('');

  // The id the codec/registry actually key on, not the picker's display
  // label — `precip`/`plates` are `precipitationLens`/`plateLens`'s LABELS,
  // their ids (and therefore their `data-option`) are `precipitation`/`plate`.
  for (const id of ['topographic', 'temperature', 'moisture', 'precipitation', 'unrest', 'plate']) {
    await lens.locator(`[data-option="${id}"]`).click();
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

test('the Look roster: every Look option renders the globe non-blank (Task 3)', async ({ page }) => {
  // One labeled Look axis replaces the three separate style/globe-style/
  // map-style rosters this test supersedes (formerly ".hud-style" here and
  // ".hud-map-style" in the diorama roster below). Voxel crosses a geometry
  // family and re-cuts the whole 95-tile selection through the amortized
  // queue. Measured under a 6x CPU throttle: ~38s for voxel, on top of the
  // boot mount — comfortably inside the timeout below. `dither3d` crosses no
  // geometry family (its Look is smooth); it swaps the surface MATERIAL, which
  // costs one pointer per mounted mesh and one shader compile — so its floor
  // here is `natural`'s. That compile is exactly what this assertion is worth
  // most for: a GLSL error fails silently to a black globe, which shows up as
  // a tiny PNG rather than as a thrown exception.
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  const globeCanvas = page.locator('canvas.view-canvas').nth(1);
  // Pause the clock (same reason as the lens roster above: a running
  // day can drift two captures onto the dark night side).
  await page.locator('[data-transport="play"]').click();
  // Rotate to bring land into view so each Look has real relief to act on.
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

  const look = await control(page, 'look', 'look');
  await expect(look).toHaveCount(1);

  // `natural` is the roster's first stop, and its frame is the baseline the
  // dither is diffed against below.
  let natural: Buffer | undefined;

  for (const id of ['natural', 'voxel', 'dither3d', 'pixel']) {
    await look.locator(`[data-option="${id}"]`).click();
    await expect(globeCanvas).toBeVisible();
    // The rebuild is amortized across frames — wait for the queue to drain,
    // not for a fixed 400ms (see `waitForGlobeIdle`).
    await waitForGlobeIdle(page);
    const shot = await globeCanvas.screenshot();
    // A geometry rebuild that throws (or a Look that renders nothing) still
    // yields a compositor frame, but a blank/degenerate one compresses to a
    // tiny PNG — the same non-blank floor the lens roster test above uses,
    // not a pixel-baseline comparison (none exists; WebGL is too noisy for
    // one).
    expect(shot.length, `${id} rendered blank`).toBeGreaterThan(5_000);
    if (id === 'natural') natural = shot;

    // A non-blank floor alone cannot see the dither's own failure mode.
    // `dither3d` is injected into three's stock `physical` shader by three
    // `String.replace` calls against chunk markers, and `String.replace` on a
    // marker that is not there is a SILENT no-op: the material still
    // compiles, the globe still renders, and the frame is simply `natural`
    // again. `three` is pinned with a caret, so a minor bump that renames a
    // chunk would ship exactly that and pass this whole test green. Diff it
    // against `natural`, the way the pixel Look's own test does — the clock
    // is paused and the camera has not moved since, so the only thing that
    // can differ is the Look. (dither3d.test.ts pins the injection targets
    // themselves; this is the end-to-end half of the same guard.)
    if (id === 'dither3d' && natural) {
      expect(shot.equals(natural), 'dither3d did not transform the frame — the shader injection is a no-op').toBe(false);
    }
  }

  expect(errors).toEqual([]);
});

test('the globe deep zoom: wheel-zooming to the new near limit in voxel style does not crash (The Massing, Task 7)', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  // Pause the clock so the world doesn't spin under the zoom.
  await page.locator('[data-transport="play"]').click();

  const look = await control(page, 'look', 'look');
  await look.locator('[data-option="voxel"]').click();
  await waitForGlobeIdle(page); // the voxel rebuild is queued, ~16 frames of it

  const globeCanvas = page.locator('canvas.view-canvas').nth(1);
  const box = (await globeCanvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  // Deep zoom-in toward the new, lowered near limit (Task 6's
  // `globeControls.minDistance`/`GLOBE_NEAR`): many wheel steps, well beyond
  // what the OLD floor needed to clear (the wheel-no-longer-switches-views
  // test above clears the pre-Massing floor in 30 steps of -120) so this
  // comfortably reaches the new, deeper minimum and exercises Task 6's
  // deeper LOD ceiling (`LOD_CDLOD_MAX_LEVEL`) plus the voxel rebuild it
  // triggers at each refine.
  for (let i = 0; i < 50; i++) {
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(60);
  }
  // Let any in-flight region replies land. Deliberately still a fixed wait:
  // what is outstanding here is WORKER latency (patch requests in the
  // cascade), not frame-paced builds — there is no build-queue backlog to
  // drain, and no signal is exposed for the request queue. A patch landing
  // after this only sharpens a tile that is already mounted, so it cannot
  // blank the frame this test asserts on.
  await page.waitForTimeout(2_000);

  await expect(globeCanvas).toBeVisible();
  const shot = await globeCanvas.screenshot();
  // Same non-blank floor as above: a crashed render or a camera clipped
  // fully into geometry (dark degenerate frame) would compress to a tiny
  // PNG; a normal frame (surface, or the exotic-peak graze case) does not.
  expect(shot.length).toBeGreaterThan(5_000);

  expect(errors).toEqual([]);
});

/** Polls the three view canvases' opacities until `predicate` passes or the
 * timeout elapses — the crossfade is ~1.5s, so a plain read racing that
 * transition would catch it mid-fade rather than settled. */
async function waitForOpacities(
  page: import('@playwright/test').Page,
  predicate: (opacities: string[]) => boolean,
  timeoutMs = 5_000,
): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const opacities = await page.evaluate(() =>
      [...document.querySelectorAll('canvas.view-canvas')].map((c) => (c as HTMLElement).style.opacity),
    );
    if (predicate(opacities)) return opacities;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`opacities did not settle in time: ${JSON.stringify(opacities)}`);
    }
    await page.waitForTimeout(100);
  }
}

test('the map rung: the status bar crosses to the flat map and back', async ({ page }) => {
  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await page.waitForTimeout(800); // a settle; this test asserts on the MAP, not on globe tiles
  // pause the clock (same idiom as the other tests)
  await page.locator('[data-transport="play"]').click();

  // The Vantage: view switching is explicit via the status bar's rung
  // buttons — the wheel no longer crosses views, it only zooms within the
  // active one.
  await page.locator('.rung[data-rung="map"]').click();

  // Let the region fetch + ~1.5s crossfade settle: the map canvas (nth 2)
  // reaches full opacity.
  await waitForOpacities(page, (opacities) => opacities[2] === '1');

  // The map canvas renders non-blank (the placeholder quad). Use a VIEWPORT
  // screenshot, NOT an element/locator one — the WebGL canvas continuously
  // re-renders, so `locator.screenshot()`'s stability wait can time out.
  await page.waitForTimeout(500); // let the region fetch settle
  const mapShot = await page.screenshot();
  expect(mapShot.length).toBeGreaterThan(5000);

  // Select back to the globe.
  await page.locator('.rung[data-rung="globe"]').click();
  await waitForOpacities(page, (opacities) => opacities[1] === '1');
});

test('the vantage: a full round-trip through the rung buttons', async ({ page }) => {
  await page.goto('#seed=42&view=system');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  await page.locator('.rung[data-rung="globe"]').click();
  await waitForOpacities(page, (opacities) => opacities[1] === '1');

  await page.locator('.rung[data-rung="map"]').click();
  await waitForOpacities(page, (opacities) => opacities[2] === '1');

  await page.locator('.rung[data-rung="system"]').click();
  await waitForOpacities(page, (opacities) => opacities[0] === '1');
});

test('the vantage: the wheel no longer switches views, only zooms', async ({ page }) => {
  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await page.waitForTimeout(800); // a settle; this test asserts on canvas OPACITIES, not globe tiles
  // pause the clock (same idiom as the other tests)
  await page.locator('[data-transport="play"]').click();

  const stage = page.locator('.view-stage');
  const box = (await stage.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  // Wheel INTO the globe hard — hard enough that, under the old
  // wheel-handoff behavior, this would have crossed the dolly floor into the
  // map rung (~26 steps used to clear it).
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1_800); // longer than the ~1.5s crossfade, so a
  // handoff (if one wrongly fired) would have finished by now.

  const opacities = await page.evaluate(() =>
    [...document.querySelectorAll('canvas.view-canvas')].map((c) => (c as HTMLElement).style.opacity),
  );
  expect(opacities[1]).toBe('1'); // still the globe
  expect(opacities[2]).toBe('0'); // the map never faded in
});

test('the diorama: switching back to pixel restores the flat map (The Diorama, Task 4)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  await page.locator('.rung[data-rung="globe"]').click();
  // A settle before crossing to the map, not a readiness dependency: nothing
  // this test asserts reads the globe's tiles (it screenshots the MAP), so it
  // does not pay for a full 96-tile drain.
  await page.waitForTimeout(2_500);
  await page.locator('.rung[data-rung="map"]').click();
  await page.waitForTimeout(3_000);

  // `natural` (mapRung: voxel) is the default (main.ts wires
  // `hud.setLook(naturalLook)` before the first frame) — switch to `pixel`
  // to exercise the kept flat-map path rather than just reading mount state.
  const look = await control(page, 'look', 'look');
  await look.locator('[data-option="pixel"]').click();
  await page.waitForTimeout(500);
  const pixelShot = await page.screenshot();
  expect(pixelShot.length).toBeGreaterThan(5_000);

  expect(errors).toEqual([]);
});

test('the overworld: the pixel map style renders non-blank and console-clean, including a pixel->voxel->pixel round trip (The Overworld, Task 5)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  // Map is not URL-addressable — reach it via globe first (same idiom as
  // the diorama tests above).
  await page.locator('.rung[data-rung="globe"]').click();
  // A settle before crossing to the map, not a readiness dependency: nothing
  // this test asserts reads the globe's tiles (it screenshots the MAP), so it
  // does not pay for a full 96-tile drain.
  await page.waitForTimeout(2_500);
  await page.locator('.rung[data-rung="map"]').click();
  await page.waitForTimeout(3_000);

  const mapCanvas = page.locator('canvas.view-canvas').nth(2);
  await expect(mapCanvas).toBeVisible();

  const look = await control(page, 'look', 'look');
  await expect(look).toHaveCount(1);

  // pixel is the overworld renderer's entry point (mapView.ts's pixel
  // branch builds `overworldTexture`) — select the `pixel` Look and confirm
  // a real, non-blank frame lands. A VIEWPORT screenshot, not an
  // element/locator one, per the same rationale as the diorama tests (the
  // WebGL canvas continuously re-renders, so a locator screenshot's
  // stability wait can time out).
  await look.locator('[data-option="pixel"]').click();
  await page.waitForTimeout(500);
  const pixelShot = await page.screenshot();
  expect(pixelShot.length).toBeGreaterThan(5_000);

  // Round-trip: pixel -> voxel -> pixel must stay clean (no leaked GPU
  // resources/state from tearing down and rebuilding the overworld texture
  // twice) and still render.
  await look.locator('[data-option="voxel"]').click();
  await page.waitForTimeout(500);
  await look.locator('[data-option="pixel"]').click();
  await page.waitForTimeout(500);
  const roundTripShot = await page.screenshot();
  expect(roundTripShot.length).toBeGreaterThan(5_000);

  expect(errors).toEqual([]);
});

test('the Look roster: the pixel Look transforms the globe frame via its post-process pass', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe&day=0.1');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });

  const globeCanvas = page.locator('canvas.view-canvas').nth(1);
  // Pause the clock (same reason as the lens roster: a running day can drift two
  // captures onto the dark night side and make them byte-identical black frames).
  await page.locator('[data-transport="play"]').click();
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

  // A post-process shader that fails to compile (e.g. a GLSL reserved-word
  // variable) renders the whole globe black — a very short,
  // highly-compressible PNG. The >5000-byte non-blank check catches that;
  // the not-equal-to-natural check confirms the Look actually transformed
  // the frame.
  const look = await control(page, 'look', 'look');
  await expect(look).toHaveCount(1);

  await look.locator('[data-option="natural"]').click();
  // `natural` is screen-space post-process free (no passes), but the
  // baseline still has to be a FULLY BUILT globe, or the later diff records
  // the amortized mount finishing rather than the Look transforming.
  await waitForGlobeIdle(page);
  await page.waitForTimeout(250);
  const natural = await globeCanvas.screenshot();
  expect(natural.length).toBeGreaterThan(5_000);

  for (const id of ['pixel']) {
    await look.locator(`[data-option="${id}"]`).click();
    await expect(globeCanvas).toBeVisible();
    await page.waitForTimeout(300);
    const shot = await globeCanvas.screenshot();
    expect(shot.length, `${id} rendered blank`).toBeGreaterThan(5_000);
    expect(shot.equals(natural), `${id} did not transform the frame`).toBe(false);
  }

  expect(errors).toEqual([]);
});

test('the excursion: dragging the map pans across a tile boundary without erroring', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await page.locator('.rung[data-rung="map"]').click();
  const mapCanvas = page.locator('canvas.view-canvas').nth(2);
  await expect(mapCanvas).toBeVisible();
  await page.waitForTimeout(2000); // let the ring's eager fetch settle

  const box = await mapCanvas.boundingBox();
  if (!box) throw new Error('map canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag far enough to cross at least one tile boundary and trigger a
  // recenter — several hundred px at whatever the default zoom is.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 400, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  expect(errors).toEqual([]);
});

test('the excursion: wheel-zoom changes the visible extent within bounds', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await page.locator('.rung[data-rung="map"]').click();
  const mapCanvas = page.locator('canvas.view-canvas').nth(2);
  await expect(mapCanvas).toBeVisible();
  await page.waitForTimeout(2000);

  const box = await mapCanvas.boundingBox();
  if (!box) throw new Error('map canvas has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Zoom out, then in — should not throw or hang either direction.
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, -800);
  await page.waitForTimeout(300);

  expect(errors).toEqual([]);
});

test('the excursion: panning toward a face-clamped edge does not error or hang', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('#seed=42&view=globe');
  await expect(page.locator('[data-status="seed"]')).toContainText('seed 42', { timeout: 150_000 });
  await page.locator('.rung[data-rung="map"]').click();
  const mapCanvas = page.locator('canvas.view-canvas').nth(2);
  await expect(mapCanvas).toBeVisible();
  await page.waitForTimeout(2000);

  const box = await mapCanvas.boundingBox();
  if (!box) throw new Error('map canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag hard and repeatedly in one direction — whether or not this
  // particular seed/region lands near a face edge, repeated large drags
  // exercise the clamp path without throwing either way.
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 500, cy - 500, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  expect(errors).toEqual([]);
});

test('the lens legend: swatches render, and change when the active lens changes (Task 10)', async ({ page }) => {
  // Neither Task 8's registry nor any unit test exercises the legend against
  // a real world in a real browser — `sheet.test.ts` renders from a FAKE
  // registry precisely so a real control never touches it (CLAUDE.md). A
  // legend frozen on the natural lens (never re-rendered for the active
  // choice) is a real bug that only a live repaint can catch.
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await bootSeed42(page, '#seed=42&view=globe&day=0.1');

  const lens = await control(page, 'lens', 'lens');
  const rows = lens.locator('.control-legend-row');
  await expect(rows.first()).toBeVisible();
  const naturalRowCount = await rows.count();
  expect(naturalRowCount).toBeGreaterThan(0);
  const naturalLabels = await lens.locator('.control-legend-label').allTextContents();
  const naturalSwatches = await lens
    .locator('.control-swatch')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.background));
  expect(naturalSwatches.length).toBe(naturalRowCount);

  // `temperature`'s legend (cold/mid/hot degree bands) shares no label and
  // no colour with `natural`'s (biome names over a green/tan/blue ramp), so
  // an unchanged legend after this click can only mean the repaint didn't
  // happen.
  await lens.locator('[data-option="temperature"]').click();
  await expect(rows.first()).toBeVisible();
  const tempLabels = await lens.locator('.control-legend-label').allTextContents();
  const tempSwatches = await lens
    .locator('.control-swatch')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.background));

  expect(tempLabels).not.toEqual(naturalLabels);
  expect(tempSwatches).not.toEqual(naturalSwatches);

  expect(errors).toEqual([]);
});

test('the date field: entering a year and day and pressing Go moves the displayed date (Task 10)', async ({ page }) => {
  // The day scrubber only spans one year (Task 8b's rationale for the field
  // existing at all) — nothing else in e2e reaches year 5, so this is the
  // only browser-level coverage of the jump actually landing.
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await bootSeed42(page, '#seed=42&view=globe');

  // Pause the clock first — left running, the autoplay frame handler
  // overwrites the status date (and the field, were it not for its own
  // dirty guard) every frame, which would make the jump's effect
  // indistinguishable from ordinary playback.
  await page.locator('[data-transport="play"]').click();

  await page.locator('.sheet-tab[data-tab="time"]').click();
  const dateStatus = page.locator('[data-status="date"]');
  const before = await dateStatus.textContent();

  const input = page.locator('.date-field input[type="text"]');
  await input.fill('5 30');
  await page.locator('[data-date="go"]').click();

  // `formatRawDate` renders 1-based year/day, matching what was typed.
  await expect(dateStatus).toContainText('Y5 · Day 30');
  expect(await dateStatus.textContent()).not.toBe(before);

  expect(errors).toEqual([]);
});
