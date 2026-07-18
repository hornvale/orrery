/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  // Absolute base matching the GitHub Pages deploy path (the deploy workflow
  // also passes `--base=/orrery/`; keeping it here makes a plain `npm run
  // build` match the deploy instead of a rootless `./` that 404s the wasm
  // under the sub-path — orrery#7). `catalogUrl` requires an absolute base.
  base: '/orrery/',
  worker: { format: 'es' },
  // e2e/ holds Playwright specs (a different test runner, different
  // `test()` global) — vitest's default glob would otherwise pick them up
  // and collide with @playwright/test's own `test()`. Extend the defaults
  // rather than replace them, so dist/ and friends stay excluded too.
  test: { environment: 'happy-dom', exclude: [...configDefaults.exclude, 'e2e/**'] },
});
