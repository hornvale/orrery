import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-nathan-Projects-hornvale-hornvale/456ac023-c6c2-4ed9-b479-2348d714a6a5/scratchpad/perf';

// PROFILE the zoom-in jerkiness (systematic-debugging Phase 1 evidence).
// Captures a V8 CPU profile via CDP + long-task durations + frame gaps while
// scripting a deep zoom that triggers LOD refinement and region streaming.
test('perf harness: deep zoom-in', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('#seed=42&view=globe&day=0.25');
  await page.locator('.hud-top-left').getByText('seed 42').waitFor({ timeout: 150_000 });

  // Instrument the page: long tasks (>50ms main-thread blocks) + frame gaps.
  await page.evaluate(() => {
    (window as any).__longtasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (window as any).__longtasks.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unsupported */ }
    (window as any).__gaps = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      (window as any).__gaps.push(Math.round(now - last));
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(500);
  // Reset gaps so we only measure the zoom window.
  await page.evaluate(() => { (window as any).__gaps = []; (window as any).__longtasks = []; });

  const globe = page.locator('canvas.view-canvas').last();
  const box = (await globe.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  const client = await page.context().newCDPSession(page);
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 100 }); // 100µs
  await client.send('Profiler.start');

  // Deep zoom-in: many wheel steps toward the surface (each step -> reselect ->
  // possibly a finer leaf set + region requests streaming back over frames).
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(60);
  }
  // Let the region replies stream in and their rebuilds land.
  await page.waitForTimeout(3000);

  const { profile } = await client.send('Profiler.stop');
  writeFileSync(`${OUT}-zoom.cpuprofile`, JSON.stringify(profile));

  const stats = await page.evaluate(() => {
    const gaps: number[] = (window as any).__gaps;
    const lt: number[] = (window as any).__longtasks;
    const buildTiles_calls = (globalThis as any).__btCount || 0;
    const buildTiles_total_ms = Math.round((globalThis as any).__btMs || 0);
    const region_swaps = (globalThis as any).__swapCount || 0;
    const sorted = [...gaps].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    return {
      frames: gaps.length,
      gap_p50: pct(50), gap_p95: pct(95), gap_max: Math.max(0, ...gaps),
      gaps_over_50ms: gaps.filter((g) => g > 50).length,
      gaps_over_100ms: gaps.filter((g) => g > 100).length,
      longtasks: lt.length,
      longtask_total_ms: lt.reduce((a, b) => a + b, 0),
      longtask_max_ms: Math.max(0, ...lt),
      buildTiles_calls,
      buildTiles_total_ms,
      region_swaps,
    };
  });
  writeFileSync(`${OUT}-stats.json`, JSON.stringify(stats, null, 2));
  console.log('ZOOM_STATS', JSON.stringify(stats));
});
