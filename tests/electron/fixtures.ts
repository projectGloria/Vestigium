import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDemoServer, type DemoOptions, type DemoServer } from '../demo-site/server.js';
import type { Result } from '../../src/shared/ipc.js';
import type { AppState, RunState, Workflow } from '../../src/shared/types.js';

// Shared Electron fixtures for milestone 2+ specs: a fresh demo server and a fresh app profile per test.
// When a test fails, the app's own log is copied into the test output before the profile is deleted.

export interface Launched { app: ElectronApplication; shell: Page }

// `demoOptions` lets a spec change the demo server (e.g. `test.use({ demoOptions: { largeBytes: 4 << 20 } })`).
export const test = base.extend<{ demoOptions: DemoOptions; demo: DemoServer; profile: string; launch: (extraEnv?: Record<string, string>) => Promise<Launched> }>({
  demoOptions: [{}, { option: true }],
  demo: async ({ demoOptions }, use, info) => {
    const demo = await createDemoServer({ port: 0, hostPort: 0, sessionRequests: 500, logDirectory: info.outputPath('demo-logs'), ...demoOptions });
    await use(demo);
    await demo.close();
  },
  profile: async ({}, use, info) => {
    const directory = await mkdtemp(join(tmpdir(), 'vestigium-electron-'));
    await use(directory);
    if (info.status !== info.expectedStatus && existsSync(join(directory, 'logs'))) {
      await cp(join(directory, 'logs'), info.outputPath('app-logs'), { recursive: true }).catch(() => {});
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-electron-')) {
      throw new Error('Refusing cleanup outside the temporary test profile.');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
  launch: async ({ profile }, use) => {
    const running: ElectronApplication[] = [];
    await use(async (extraEnv = {}) => {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      env.VESTIGIUM_USER_DATA = profile;
      env.VESTIGIUM_TEST = '1';
      // Files go into the temporary profile, never into the real Downloads folder.
      env.VESTIGIUM_DOWNLOADS = join(profile, 'downloads');
      // Tests never fetch filter lists from the network; the bundled lists (or a spec's own) are used as they are.
      env.VESTIGIUM_FILTER_REFRESH = 'off';
      Object.assign(env, extraEnv);
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_RENDERER_URL;
      const app = await electron.launch({ args: [resolve('out/main/app.cjs')], env, timeout: 30_000 });
      running.push(app);
      app.process().stderr?.on('data', data => console.log(String(data)));
      // The app offers links from the clipboard. Tests must neither read nor write the real clipboard of this
      // machine, so the app's clipboard read is replaced with one that reads __testClipboard (set by tests).
      await app.evaluate(({ clipboard }) => {
        const holder = globalThis as unknown as { __testClipboard?: string };
        clipboard.readText = (async () => holder.__testClipboard ?? '') as unknown as typeof clipboard.readText;
      });
      const shell = await app.firstWindow();
      await expect(shell.getByRole('button', { name: 'Go', exact: true })).toBeVisible();
      return { app, shell };
    });
    for (const app of running) await app.close().catch(() => {});
  },
});

export { expect };

type BridgeCall = 'getState' | 'recordStart' | 'recordStop' | 'stopRun';
export const call = (shell: Page, method: BridgeCall) => shell.evaluate(name => window.vestigium[name](), method) as Promise<Result>;
export const run = (shell: Page, id: string) => shell.evaluate(workflow => window.vestigium.runWorkflow(workflow), id) as Promise<Result>;

export async function state(shell: Page): Promise<AppState> {
  const result = await call(shell, 'getState');
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

// Navigates the active tab through the shell's URL box, dismisses the demo cookie banner, returns the tab's page.
export async function open(app: ElectronApplication, shell: Page, url: string) {
  await shell.getByRole('textbox', { name: 'URL', exact: true }).fill(url);
  await shell.getByRole('button', { name: 'Go', exact: true }).click();
  await expect.poll(() => app.context().pages().some(page => page.url() === url)).toBe(true);
  const page = app.context().pages().find(candidate => candidate.url() === url)!;
  await page.waitForLoadState();
  const banner = page.getByRole('button', { name: 'Accept cookies' });
  if (await banner.isVisible()) await banner.click();
  return page;
}

export async function stopRecording(shell: Page): Promise<Workflow> {
  const result = await call(shell, 'recordStop');
  if (!result.ok) throw new Error(result.error);
  expect(result.state.recording.active).toBe(false);
  return result.state.selectedWorkflow!;
}

export async function finishedRun(shell: Page, timeout = 60_000): Promise<RunState> {
  await expect.poll(async () => (await state(shell)).run?.status, { timeout }).not.toBe('running');
  return (await state(shell)).run!;
}

export const logged = async (shell: Page, prefix: string) => (await state(shell)).logs.filter(entry => entry.message.startsWith(prefix)).length;
