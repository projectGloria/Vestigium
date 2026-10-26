import { test as base, expect } from '@playwright/test';
import { createDemoServer, type DemoOptions, type DemoServer } from './demo-site/server.js';
export const test = base.extend<{ demo: DemoServer; demoOptions: DemoOptions }>({
  demoOptions: [{}, { option: true }],
  demo: async ({ demoOptions }, use, info) => {
    const demo = await createDemoServer({ port: 0, hostPort: 0, logDirectory: info.outputPath('logs'), ...demoOptions });
    try { await use(demo); } finally { await demo.close(); }
  },
});
export { expect };
