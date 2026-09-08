import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'ads.browser.spec.ts',
  outputDir: '../../test-results/ad-guard',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
});
