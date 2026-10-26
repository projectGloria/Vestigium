import { resolve } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { test, expect, call, finishedRun, logged, open, run, state, stopRecording } from './fixtures.js';

// Ad blocking: the demo's "ad network" (second origin, /demo-ads/) is on the test filter list. Its banner never
// loads, its popunder never opens, an ad popup opened by the page itself is refused, and turning blocking off
// brings all of it back. A recording on the ad page sees only the page's own content and replays.

const LISTS = { VESTIGIUM_FILTER_LISTS: resolve('tests/demo-site/filter-lists') };
const pageCount = (app: ElectronApplication) => app.context().pages().filter(page => !page.url().startsWith('file:') && page.url() !== 'about:blank').length;

test('ads and popunders are blocked by default; the setting turns blocking off and on', async ({ demo, launch }) => {
  const { app, shell } = await launch(LISTS);
  expect((await state(shell)).adblock).toMatchObject({ enabled: true, filters: 1, listsUpdated: '2026-10-24T00:00:00.000Z' });
  const page = await open(app, shell, `${demo.origin}/ads`);
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#demo-ad')).toHaveCount(0);
  // The first click anywhere (the cookie banner's, in open()) would have opened the popunder; nothing opened.
  await page.locator('#content').click();
  await page.getByRole('button', { name: 'Visit our sponsor' }).click();
  await expect.poll(() => logged(shell, 'Blocked an ad popup.')).toBe(1);
  expect((await state(shell)).tabs).toHaveLength(1);
  expect((await state(shell)).adblock.blocked).toBeGreaterThanOrEqual(2); // the banner script and the sponsor popup

  // Turned off from the settings panel (persisted), the same page shows its ad and the popunder opens.
  await shell.getByText('Safety, ads and tray').click();
  await expect(shell.getByLabel('Ad blocking status')).toContainText('1 filters, lists from 2026-10-24');
  await shell.getByRole('checkbox', { name: 'Block ads and trackers in browser tabs' }).uncheck();
  await expect.poll(async () => (await state(shell)).settings.adblock.enabled).toBe(false);
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Advertisement' })).toHaveText('Sponsored: win a prize!');
  await page.locator('#content').click();
  await expect.poll(async () => (await state(shell)).tabs.map(tab => tab.title)).toContain('Advertisement · Vestigium');

  await shell.getByRole('checkbox', { name: 'Block ads and trackers in browser tabs' }).check();
  await expect.poll(async () => (await state(shell)).settings.adblock.enabled).toBe(true);
  await page.bringToFront();
  await page.reload();
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#demo-ad')).toHaveCount(0);
});

test('a recording on an ad page contains only the page\'s own steps and replays with the download', async ({ demo, launch }) => {
  const { app, shell } = await launch(LISTS);
  const page = await open(app, shell, `${demo.origin}/ads`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested (field-notes.zip)')).toBe(1);
  const workflow = await stopRecording(shell);
  // No popunder: the click recorded is the download, not a popup that an ad script opened.
  expect(JSON.stringify(workflow.steps)).not.toContain('demo-ads');
  expect(JSON.stringify(workflow.steps)).not.toContain('"popup"');
  expect(pageCount(app)).toBe(1);

  expect((await run(shell, workflow.id)).ok).toBe(true);
  const result = await finishedRun(shell);
  expect(result).toMatchObject({ status: 'done', error: null });
  await expect.poll(() => logged(shell, 'Download started: field-notes.zip')).toBe(1);
  expect((await state(shell)).tabs).toHaveLength(1);
});

test('the bundled lists load on a fresh profile and are cached for the next start', async ({ launch }) => {
  let launched = await launch();
  const first = (await state(launched.shell)).adblock;
  expect(first.enabled).toBe(true);
  expect(first.filters).toBeGreaterThan(50_000);
  expect(await logged(launched.shell, 'Ad blocking ready:')).toBe(1);
  expect((await state(launched.shell)).logs.some(entry => /bundled lists from/.test(entry.message))).toBe(true);
  await launched.app.close();

  launched = await launch();
  expect((await state(launched.shell)).adblock.filters).toBe(first.filters);
  // The log file spans both starts: the second one was served from the cache ("lists from", not "bundled lists from").
  expect((await state(launched.shell)).logs.filter(entry => /^Ad blocking ready: \d+ filters \(lists from/.test(entry.message))).toHaveLength(1);
});
