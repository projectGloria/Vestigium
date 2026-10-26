import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', fullyParallel: true,
  // Electron specs run under playwright.electron.config.ts; installer checks under playwright.package.config.ts.
  testIgnore: ['**/electron/**', '**/package/**'],
  workers: 4, timeout: 30_000, reporter: [['list']],
  use: { browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
