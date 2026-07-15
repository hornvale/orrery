/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // e2e/ holds Playwright specs (a different test runner, different
  // `test()` global) — vitest's default glob would otherwise pick them up
  // and collide with @playwright/test's own `test()`.
  test: { environment: 'happy-dom', exclude: ['node_modules/**', 'e2e/**'] },
});
