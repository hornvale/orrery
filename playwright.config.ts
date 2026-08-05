import { defineConfig } from '@playwright/test';

/** The smoke runs against the REAL production shape: `dist/` built with
 * `--base=/orrery/`, served under that sub-path — the base-path 404 class
 * of bug (the campaign's one production bug) is exactly what this exists
 * to catch. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  // Every spec boots its own world and is independent of its neighbours, so
  // tests — not files — are the unit of work. This matters for CI: `--shard`
  // splits by FILE unless `fullyParallel` is set, and with 16 of the 18 tests
  // living in smoke.spec.ts, file-level sharding puts everything on one runner
  // and leaves the rest idle (verified: `--shard=1/4 --list` reported all 18).
  fullyParallel: true,
  // …but parallelism WITHIN a runner is a different question. These are
  // WebGL-heavy: several live globes on one box contend for the GPU and start
  // tripping the timing-sensitive waits (`waitForGlobeIdle`'s 90 s drain, the
  // canvas-stability screenshots). CI runners are 2-core, so one worker there
  // and the parallelism comes from sharding across runners instead. Locally,
  // 2 matches what `fullyParallel: false` already gave us (two spec files, two
  // workers), so this is not a change in local behaviour.
  workers: process.env.CI ? 1 : 2,
  use: {
    baseURL: 'http://127.0.0.1:4173/orrery/',
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:4173/orrery/',
    reuseExistingServer: !process.env.CI,
  },
});
