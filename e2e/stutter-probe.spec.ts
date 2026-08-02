import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Correlate frame gaps with tile BUILDS (systematic-debugging Phase 1 evidence
// for the terrain-load stutter). The existing perf-harness reports gaps and
// build counters side by side but never joins them, so it cannot answer the
// one question that matters: are the long frames the frames that build tiles?
// This samples `__slotBuildCount`/`__buildPending` per rAF and buckets the gaps.
const OUT_DIR = 'test-results/perf';
mkdirSync(OUT_DIR, { recursive: true });

const INSTRUMENT = (): void => {
  const w = window as any;
  w.__frames = [];
  let last = performance.now();
  let lastBuilds = 0;
  const tick = (): void => {
    const now = performance.now();
    const builds = (globalThis as any).__slotBuildCount ?? 0;
    w.__frames.push({
      gap: Math.round(now - last),
      built: builds - lastBuilds,
      pending: (globalThis as any).__buildPending ?? 0,
    });
    lastBuilds = builds;
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

interface Frame {
  gap: number;
  built: number;
  pending: number;
}

function report(label: string, frames: Frame[]): Record<string, unknown> {
  const withBuilds = frames.filter((f) => f.built > 0);
  const without = frames.filter((f) => f.built === 0);
  const stat = (xs: number[]): Record<string, number> => {
    if (xs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
    const s = [...xs].sort((a, b) => a - b);
    return {
      n: s.length,
      p50: s[Math.floor(s.length * 0.5)]!,
      p95: s[Math.floor(s.length * 0.95)]!,
      max: s[s.length - 1]!,
    };
  };
  return {
    label,
    frames: frames.length,
    building: stat(withBuilds.map((f) => f.gap)),
    idle: stat(without.map((f) => f.gap)),
    worst: [...frames].sort((a, b) => b.gap - a.gap).slice(0, 12),
  };
}

test('stutter probe: boot + zoom, gaps joined to builds @perf', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(INSTRUMENT);
  await page.goto('#seed=42&view=globe&day=0.25');
  await page.locator('.hud-top-left').getByText('seed 42').waitFor({ timeout: 150_000 });

  // Boot window: the 96-tile base mount and its region cascade.
  await page.waitForFunction(() => ((globalThis as any).__buildPending ?? 1) === 0, null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(1500);
  const boot = report('boot', await page.evaluate(() => (window as any).__frames));

  await page.evaluate(() => {
    (window as any).__frames = [];
  });

  const globe = page.locator('canvas.view-canvas').last();
  const box = (await globe.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(3000);
  const zoom = report('zoom', await page.evaluate(() => (window as any).__frames));

  const totals = await page.evaluate(() => ({
    slotBuilds: (globalThis as any).__slotBuildCount ?? 0,
    swaps: (globalThis as any).__swapCount ?? 0,
    btCount: (globalThis as any).__btCount ?? 0,
    btMs: Math.round((globalThis as any).__btMs ?? 0),
    stitchMs: Math.round((globalThis as any).__stitchMs ?? 0),
    stitchCount: (globalThis as any).__stitchCount ?? 0,
  }));

  const out = { boot, zoom, totals };
  try {
    writeFileSync(`${OUT_DIR}/stutter.json`, JSON.stringify(out, null, 2));
  } catch {
    /* diagnostic artifact — never fail the run on a write error */
  }
  console.log('STUTTER', JSON.stringify(out, null, 2));
});
