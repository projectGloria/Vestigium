import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { RunSettings, Step } from '../../src/shared/types.js';
import { generatedChunk } from '../demo-site/downloads.js';
import { FILENAMES, ITEMS } from '../demo-site/fixtures.js';
import { test, expect, call, finishedRun, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 6 definition of done: "Killing the app mid-download and reopening resumes the queue and partial files;
// the dead link doesn't block the rest." Plus the queue UI, files behind a login, popups and Windows-safe names.

const LARGE = 4 << 20;
test.use({ demoOptions: { largeBytes: LARGE } });

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const queue = (shell: Page) => shell.getByRole('tabpanel', { name: 'Queue' });
type LoopPages = Extract<Step, { type: 'loop_pages' }>;

test('killing the app mid-download and reopening it resumes the queue and the partial file', async ({ demo, launch, profile }, info) => {
  test.setTimeout(120_000);
  let { app, shell } = await launch();
  // About 8 s for 4 MB, so there is time to kill the app in the middle.
  const page = await open(app, shell, `${demo.origin}/item/1?variant=large&throttle=500000`);
  await page.getByRole('link', { name: 'Download ZIP / generated file' }).click();
  await expect.poll(async () => (await state(shell)).downloads.rows[0]?.receivedBytes ?? 0, { timeout: 20_000 }).toBeGreaterThan(1 << 20);
  await expect(queue(shell).getByRole('row', { name: 'generated.bin' })).toContainText('Downloading');
  await shell.screenshot({ path: info.outputPath('queue-downloading.png') });

  // A hard kill of the whole process tree (TerminateProcess): nothing gets a chance to save or clean up. Killing only
  // app.process() is not enough on Windows: that is a launcher whose child is the real Electron browser process.
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F']);
  await exited;
  const partial = (await readdir(join(profile, 'downloads', '.vestigium-parts')));
  expect(partial).toHaveLength(1);

  ({ app, shell } = await launch());
  await expect.poll(() => logged(shell, 'Resuming the download queue: 1 download (1 interrupted by the last shutdown).')).toBe(1);
  await expect.poll(() => logged(shell, 'Resuming "generated.bin" at ')).toBe(1);
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 60_000 }).toBe(1);
  const [row] = (await state(shell)).downloads.rows;
  expect(row).toMatchObject({ status: 'done', filename: 'generated.bin', receivedBytes: LARGE, totalBytes: LARGE, error: null });
  expect(row.finalPath).toBe(join(profile, 'downloads', '127.0.0.1', 'generated.bin'));
  // Byte for byte the file the server serves: the resumed half was appended at exactly the right offset.
  expect(sha(await readFile(row.finalPath!))).toBe(sha(generatedChunk(0, LARGE)));
  expect(await readdir(join(profile, 'downloads', '.vestigium-parts'))).toEqual([]);
  // The server saw the second half as a range request. (The demo logs only completed responses: the transfer that was
  // killed, and Chromium's own request that the queue cancelled, never completed.)
  const served = (await readFile(info.outputPath('demo-logs', 'demo.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { path: string; status: number });
  expect(served.filter(entry => entry.path === '/files/large').map(entry => entry.status)).toEqual([206]);
  await expect(queue(shell).getByRole('row', { name: 'generated.bin' })).toContainText('Done');
});

test('a dead download link marks its item and never blocks the rest; a second run skips what is already downloaded', async ({ demo, launch, profile }) => {
  test.setTimeout(180_000);
  const { app, shell } = await launch();
  const list = await open(app, shell, `${demo.origin}/list?dead=3`);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await list.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await list.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested (field-notes.zip)')).toBe(1);
  const workflow = await stopRecording(shell);
  expect(await logged(shell, 'Teaching: the download is recorded, not saved.')).toBe(1);
  const pages = workflow.steps[1] as LoopPages;
  const items = pages.params.steps[0];
  expect((await shell.evaluate(([id, version, stepId]) => window.vestigium.updateWorkflow(id as string, version as number,
    { kind: 'set-max-pages', stepId: stepId as string, maxPages: 1 }), [workflow.id, workflow.version, pages.id] as const)).ok).toBe(true);

  const started = Date.now();
  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  let run = await finishedRun(shell, 120_000);
  expect(run.status, run.error ?? '').toBe('done');
  // The dead link is recognized from the error page it leads to, not after the 60 s download timeout.
  expect(Date.now() - started).toBeLessThan(45_000);
  const loop = run.results.filter(result => result.stepId === items.id).at(-1)!;
  expect(loop.message).toMatch(new RegExp(`^Opened 9 items; 1 failed \\("${ITEMS[2].title}": .* The download link led to an error page \\(HTTP 404\\) instead of a file\\.\\)\\.$`));
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 60_000 }).toBe(9);
  expect(await readdir(join(profile, 'downloads', '127.0.0.1'))).toEqual(['field-notes.zip', 'field-notes_info.txt']);

  // Run again: the 9 downloaded items are not even opened; only the item without a download is tried again.
  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  run = await finishedRun(shell, 60_000);
  const again = run.results.filter(result => result.stepId === items.id).at(-1)!;
  expect(again.message).toMatch(/^All 1 item failed \(9 already downloaded\)\. First: /);
  expect((await state(shell)).downloads.counts.done).toBe(9);
});

test('the queue UI pauses, resumes and shows files; downloads behind a login, from popups and with odd names work', async ({ demo, launch, profile }, info) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await shell.getByRole('tab', { name: 'Queue' }).click();
  await expect(queue(shell)).toContainText('No downloads yet');

  // A throttled file, paused and resumed from its row.
  const page = await open(app, shell, `${demo.origin}/item/1?variant=large&throttle=800000`);
  await page.getByRole('link', { name: 'Download ZIP / generated file' }).click();
  const row = queue(shell).getByRole('row', { name: 'generated.bin' });
  await expect(row).toContainText('Downloading');
  await expect.poll(async () => (await state(shell)).downloads.rows[0].receivedBytes).toBeGreaterThan(300_000);
  await row.getByRole('button', { name: 'Pause generated.bin' }).click();
  await expect(row).toContainText('Paused');
  const paused = (await state(shell)).downloads.rows[0].receivedBytes;
  expect(paused).toBeGreaterThan(0);
  expect(paused).toBeLessThan(LARGE);
  await row.getByRole('button', { name: 'Resume generated.bin' }).click();
  await expect(row).toContainText('Done', { timeout: 30_000 });
  expect(await logged(shell, 'Resuming "generated.bin" at ')).toBe(1);
  await expect(row.getByRole('button', { name: 'Show generated.bin in folder' })).toBeVisible();

  // Behind a login: the queue fetches with the browser session's cookies (without them the host sends its login page).
  const login = await open(app, shell, `${demo.origin}/login?returnTo=${encodeURIComponent('/item/2?login=1')}`);
  await login.getByLabel('Username').fill('demo');
  await login.getByLabel('Password').fill('vestigium');
  await login.getByRole('button', { name: 'Sign in' }).click();
  await expect(login).toHaveURL(`${demo.origin}/item/2?login=1`);
  await login.getByRole('link', { name: 'Download ZIP' }).click();
  await expect(queue(shell).getByRole('row', { name: 'field-notes.zip' })).toContainText('Done');

  // A Windows-hostile name and a Unicode name (same ZIP bytes: recorded as identical, not stored again).
  for (const variant of ['invalid', 'unicode'] as const) {
    const item = await open(app, shell, `${demo.origin}/item/3?variant=${variant}`);
    await item.getByRole('link', { name: 'Download ZIP' }).click();
  }
  await expect(queue(shell).getByRole('row', { name: 'CON_notes___draft____.zip' })).toContainText('Identical to a file already saved');
  await expect(queue(shell).getByRole('row', { name: FILENAMES.unicode })).toContainText('Done');

  // A download that starts by itself in a popup, from another origin.
  const popupPage = await open(app, shell, `${demo.origin}/item/4?variant=popup`);
  await popupPage.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 30_000 }).toBe(5);
  expect((await readdir(join(profile, 'downloads', '127.0.0.1'))).sort()).toEqual(['field-notes.zip', 'field-notes_info.txt', 'generated.bin', 'generated_info.txt']);
  expect(await logged(shell, 'Download queue finished: ')).toBeGreaterThan(0);
  await shell.screenshot({ path: info.outputPath('queue-panel.png') });
});
