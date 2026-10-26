import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createDemoServer, type DemoServer } from '../demo-site/server.js';

let directory: string; let demo: DemoServer; let running: ElectronApplication[];
test.beforeEach(async ({}, info) => { directory = await mkdtemp(join(tmpdir(), 'vestigium-electron-')); running = []; demo = await createDemoServer({ port: 0, hostPort: 0, sessionRequests: 100, logDirectory: info.outputPath('demo-logs') }); });
test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => {}); await demo.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-electron-')) throw new Error('Refusing cleanup outside the temporary test profile.');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
async function launch(profile = directory) {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.VESTIGIUM_USER_DATA = profile; env.VESTIGIUM_TEST = '1'; env.VESTIGIUM_FILTER_REFRESH = 'off'; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [resolve('out/main/app.cjs')], env, timeout: 30000 }); running.push(app);
  app.process().stderr?.on('data', data => console.log(String(data)));
  const shell = await app.firstWindow(); await expect(shell.getByRole('button', { name: 'Go', exact: true })).toBeVisible();
  await expect.poll(async () => (await shell.evaluate(() => window.vestigium.getState())).ok).toBe(true);
  return { app, shell };
}
async function close(app: ElectronApplication) { await app.close(); running = running.filter(candidate => candidate !== app); }
async function navigate(app: ElectronApplication, shell: Page, url: string) {
  await shell.getByRole('textbox', { name: 'URL', exact: true }).fill(url); await shell.getByRole('button', { name: 'Go', exact: true }).click();
  await expect.poll(() => app.context().pages().some(page => page.url().startsWith(demo.origin) || page.url().startsWith(demo.hostOrigin))).toBe(true);
  const page = app.context().pages().find(page => page.url().startsWith(demo.origin) || page.url().startsWith(demo.hostOrigin))!;
  await page.waitForLoadState(); return page;
}
async function login(page: Page) {
  const banner = page.getByRole('button', { name: 'Accept cookies' }); if (await banner.isVisible()) await banner.click();
  await page.getByLabel('Username', { exact: true }).fill('demo'); await page.getByLabel('Password', { exact: true }).fill('vestigium');
  await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page.getByRole('heading', { name: 'The field notes collection' })).toBeVisible();
}
test('app launches with all panels, database and a working Log tab', async ({}, info) => {
  const { app, shell } = await launch();
  for (const label of ['Workflow', 'Site profiles']) await expect(shell.getByRole('region', { name: label })).toBeVisible();
  await expect(shell.getByRole('main', { name: 'Browser pane' })).toBeVisible();
  for (const label of ['Queue', 'History']) await expect(shell.getByRole('tab', { name: label, exact: true })).toBeVisible();
  await shell.getByRole('tab', { name: /^Log/ }).click(); await expect(shell.getByRole('tabpanel', { name: 'Log' })).toContainText('persistent browser profile ready');
  expect((await readFile(join(directory, 'vestigium.sqlite'))).subarray(0, 15).toString()).toBe('SQLite format 3');
  await shell.screenshot({ path: info.outputPath('shell.png') });
  const sandboxed = await app.evaluate(({ app, BrowserWindow }) => app.getAppMetrics().find(metric => metric.pid === BrowserWindow.getAllWindows()[0].webContents.getOSProcessId())?.sandboxed);
  if (process.platform !== 'linux') expect(sandboxed).toBe(true);
  expect(await shell.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
});
test('login survives a full app restart using the same profile; fresh profile has no session', async () => {
  let { app, shell } = await launch();
  const page = await navigate(app, shell, `${demo.origin}/list?login=1`); await login(page);
  const cookieValue = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:vestigium').cookies.get({})).find(cookie => cookie.name.startsWith('vestigium_'))?.value);
  expect(cookieValue).toBeTruthy(); await close(app);
  const bytes = await readFile(join(directory, 'session-cookies.enc')); expect(bytes.includes(Buffer.from(cookieValue!))).toBe(false);
  ({ app, shell } = await launch());
  await expect.poll(() => app.context().pages().some(candidate => candidate.url() === `${demo.origin}/list?login=1`)).toBe(true);
  const restored = app.context().pages().find(candidate => candidate.url() === `${demo.origin}/list?login=1`)!;
  await expect(restored.getByRole('heading', { name: 'The field notes collection' })).toBeVisible(); await close(app);
  ({ app, shell } = await launch(join(directory, 'fresh-profile')));
  const fresh = await navigate(app, shell, `${demo.origin}/list?login=1`); await expect(fresh.getByRole('heading', { name: 'Demo login' })).toBeVisible();
});
test('popup is a managed browser tab with no additional app window', async () => {
  const { app, shell } = await launch(); const page = await navigate(app, shell, `${demo.origin}/item/1?variant=popup`);
  await page.getByRole('button', { name: 'Accept cookies' }).click();
  await page.getByRole('link', { name: 'Download ZIP', exact: true }).click();
  await expect(shell.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')).toHaveCount(2);
  await expect(shell.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue(`${demo.hostOrigin}/popup?`);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const popup = app.context().pages().find(candidate => candidate.url().startsWith(demo.hostOrigin))!;
  expect(await popup.evaluate(() => typeof window.vestigium)).toBe('undefined');
  await shell.getByRole('button', { name: 'Close Download in a new tab · Vestigium', exact: true }).click();
  await expect(shell.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')).toHaveCount(1);
});
test('web content has no bridge or Node; shell IPC rejects invalid requests and unsafe navigation', async () => {
  const { app, shell } = await launch(); const page = await navigate(app, shell, `${demo.origin}/list`);
  expect(await page.evaluate(() => ({ bridge: typeof window.vestigium, node: typeof (window as unknown as { require?: unknown }).require, process: typeof (window as unknown as { process?: unknown }).process }))).toEqual({ bridge: 'undefined', node: 'undefined', process: 'undefined' });
  const security = await app.evaluate(({ app, webContents }) => webContents.getAllWebContents().filter(contents => contents.getURL().startsWith('http://127.0.0.1')).map(contents => app.getAppMetrics().find(metric => metric.pid === contents.getOSProcessId())?.sandboxed));
  if (process.platform !== 'linux') for (const sandboxed of security) expect(sandboxed).toBe(true);
  expect(await shell.evaluate(() => window.vestigium.navigate('file:///C:/Windows/win.ini'))).toMatchObject({ ok: false });
  expect(await shell.evaluate(() => window.vestigium.selectTab(-1))).toMatchObject({ ok: false });
  const shellUrl = shell.url(); await shell.evaluate(() => { location.href = 'https://example.com'; });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(shellUrl);
  expect(await shell.evaluate(() => window.vestigium.getState())).toMatchObject({ ok: true });
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
});
test('theme, URL and window bounds survive restart; native view follows resize', async () => {
  let { app, shell } = await launch(); await navigate(app, shell, `${demo.origin}/list?layout=table`);
  await shell.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(shell.locator('html')).toHaveAttribute('data-theme', 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 90, width: 1100, height: 760 }));
  await expect.poll(async () => {
    const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds());
    const rect = await shell.locator('.browser-space').boundingBox();
    return rect && native.width === Math.round(rect.width) && native.height === Math.round(rect.height) && native.x === Math.round(rect.x) && native.y === Math.round(rect.y);
  }).toBe(true);
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await close(app); ({ app, shell } = await launch());
  await expect(shell.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(shell.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue(`${demo.origin}/list?layout=table`);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(before);
});
test('Back, Forward, Reload and tab controls work; closing the last tab keeps a blank tab', async ({}, info) => {
  const { app, shell } = await launch(); const page = await navigate(app, shell, `${demo.origin}/list`);
  await page.getByRole('button', { name: 'Accept cookies' }).click();
  await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await expect(shell.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
  await shell.getByRole('button', { name: 'Back', exact: true }).click(); await expect(page.getByRole('heading', { name: 'The field notes collection' })).toBeVisible();
  await shell.getByRole('button', { name: 'Forward', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Field Notes 01' })).toBeVisible();
  await Promise.all([page.waitForEvent('load'), shell.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await expect(page.getByRole('heading', { name: 'Field Notes 01' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('browser-page.png') });
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await writeFile(info.outputPath('browser-in-shell.png'), Buffer.from(screenshot, 'base64'));
  await shell.getByRole('button', { name: 'New tab', exact: true }).click();
  const tablist = shell.getByRole('tablist', { name: 'Browser tabs' }); await expect(tablist.getByRole('tab')).toHaveCount(2);
  await tablist.getByRole('tab', { name: /Field Notes 01/ }).click();
  await shell.getByRole('button', { name: 'Close New tab', exact: true }).click(); await expect(tablist.getByRole('tab')).toHaveCount(1);
  await shell.getByRole('button', { name: 'Close Field Notes 01 · Vestigium', exact: true }).click();
  await expect(tablist.getByRole('tab', { name: /New tab/ })).toHaveCount(1);
  const state = await shell.evaluate(() => window.vestigium.getState()); expect(state.ok && state.state.settings.lastUrl).toBe('about:blank');
});
