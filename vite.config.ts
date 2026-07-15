/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // e2e/ holds Playwright specs (a different test runner, different
  // `test()` global) — vitest's default glob would otherwise pick them up
  // and collide with @playwright/test's own `test()`. Extend the defaults
  // rather than replace them, so dist/ and friends stay excluded too.
  test: { environment: 'happy-dom', exclude: [...configDefaults.exclude, 'e2e/**'] },
});
