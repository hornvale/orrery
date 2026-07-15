import { defineConfig } from '@playwright/test';

/** The smoke runs against the REAL production shape: `dist/` built with
 * `--base=/orrery/`, served under that sub-path — the base-path 404 class
 * of bug (the campaign's one production bug) is exactly what this exists
 * to catch. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  use: { baseURL: 'http://127.0.0.1:4173/orrery/' },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:4173/orrery/',
    reuseExistingServer: !process.env.CI,
  },
});
