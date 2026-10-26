import { defineConfig } from '@playwright/test';
// The installed-app checks (milestone 9): run after `npm run dist`, separately from `npm test`.
export default defineConfig({
  testDir: './tests/package', workers: 1, timeout: 120_000,
  reporter: [['list']], outputDir: 'test-results/package',
});
