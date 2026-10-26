import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { RunSettings, Step } from '../../src/shared/types.js';
import { PHOTO_LIST } from '../demo-site/downloads.js';
import { ITEMS, PASSWORD, ZIP_TEXT } from '../demo-site/fixtures.js';
import { test, expect, call, finishedRun, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 7 definition of done: "Password and metadata from item pages end up in the sidecar file; archive
// extraction works." Every item of /list?variant=aes serves a password-protected AES-256 ZIP made by 7-Zip; items
// 1-4 show the password under four different labels, item 5 shows none.

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };
type LoopPages = Extract<Step, { type: 'loop_pages' }>;
const queue = (shell: Page) => shell.getByRole('tabpanel', { name: 'Queue' });

test('a crawl saves each item\'s details in its sidecar and unpacks each archive with the password from its page', async ({ demo, launch, profile }, info) => {
  test.setTimeout(180_000);
  const { app, shell } = await launch();
  const list = await open(app, shell, `${demo.origin}/list?variant=aes`);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await list.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await list.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested (field-notes-aes.zip)')).toBe(1);
  const workflow = await stopRecording(shell);
  const pages = workflow.steps[1] as LoopPages;
  let version = workflow.version;
  for (const change of [{ kind: 'set-max-pages', stepId: pages.id, maxPages: 1 }, { kind: 'set-max-items', stepId: pages.params.steps[0].id, maxItems: 5 }]) {
    const result = await shell.evaluate(([id, at, what]) => window.vestigium.updateWorkflow(id as string, at as number, what as never), [workflow.id, version, change] as const);
    if (!result.ok) throw new Error(result.error);
    version = result.state.selectedWorkflow!.version;
  }

  // Options, set in the Queue tab: a template, unpack-and-delete, sidecars on. Force, because every demo item serves
  // the same archive bytes, which would otherwise be stored once (identical-file dedupe).
  await shell.getByRole('tab', { name: 'Queue' }).click();
  await queue(shell).getByText('Download options').click();
  const names = queue(shell).getByRole('textbox', { name: 'File names' });
  await names.fill('{site}/{tag}/{title}.{ext}');
  await names.press('Enter');
  await queue(shell).getByRole('combobox', { name: 'Unpack archives' }).selectOption('delete');
  await queue(shell).getByLabel('Force').check();
  await expect.poll(async () => (await state(shell)).settings.downloads).toMatchObject({ template: '{site}/{tag}/{title}.{ext}', extract: 'delete', sidecar: true, force: true });
  await expect(queue(shell).getByRole('textbox', { name: 'Details to capture' })).toHaveValue(/^Password, Pass, Unzip password, Archive password, Şifre, /);

  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  const run = await finishedRun(shell, 120_000);
  expect(run.status, run.error ?? '').toBe('done');
  await expect.poll(async () => (await state(shell)).downloads.rows.filter(row => row.status === 'done' && row.extractNote).length, { timeout: 60_000 }).toBe(5);
  expect(await logged(shell, 'Item details: Title, Author, Tags, Date')).toBe(5);

  const site = join(profile, 'downloads', '127.0.0.1');
  for (const item of ITEMS.slice(0, 5)) {
    const folder = join(site, item.tag);
    const sidecar = await readFile(join(folder, `${item.title}_info.txt`), 'utf8');
    expect(sidecar).toContain(`Title: ${item.title}\r\n`);
    expect(sidecar).toContain(`Author: ${item.author}\r\n`);
    expect(sidecar).toContain(`Tags: ${item.tag}\r\n`);
    expect(sidecar).toContain(`Date: ${item.date}\r\n`);
    expect(sidecar).toContain(`Page: ${demo.origin}/item/${item.id}?variant=aes\r\n`);
    if (item.passwordLabel) {
      // The page's own label ("Unzip password:", "Şifre:") is kept, and the password comes first after the title.
      expect(sidecar.split('\r\n')[1]).toBe(`${item.passwordLabel.replace(/:$/, '')}: ${PASSWORD}`);
      expect(await readFile(join(folder, item.title, 'notes', 'readme.txt'), 'utf8')).toBe(ZIP_TEXT);
      expect(await readFile(join(folder, item.title, 'notes', 'photo-list.txt'), 'utf8')).toBe(PHOTO_LIST);
      expect(sidecar).toContain(`Unpacked to: ${join(folder, item.title)}\r\n`);
      // Unpacked, so the archive itself is gone.
      expect((await readdir(folder)).includes(`${item.title}.zip`)).toBe(false);
    } else {
      expect(sidecar).not.toContain(PASSWORD);
      expect((await readdir(folder)).includes(`${item.title}.zip`)).toBe(true);
    }
  }
  const rows = (await state(shell)).downloads.rows;
  expect(rows.find(row => row.title === ITEMS[4].title)!.extractNote).toBe('Not unpacked: The archive is password-protected, and the item page showed no password.');
  await expect(queue(shell).getByRole('row', { name: 'Field Notes 03.zip' })).toContainText('Unpacked 2 files into');
  await expect(queue(shell).getByRole('row', { name: 'Field Notes 03.zip' })).toContainText('Details: Author, Tags, Date, Unzip password');
  // The password is in the sidecars and the database, never in the log.
  expect((await state(shell)).logs.some(entry => entry.message.includes(PASSWORD))).toBe(false);
  await shell.screenshot({ path: info.outputPath('queue-unpacked.png') });
});

test('a manual download reads the details of the page it came from', async ({ demo, launch, profile }) => {
  const { app, shell } = await launch();
  const page = await open(app, shell, `${demo.origin}/item/4?meta=table`);
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(async () => (await state(shell)).downloads.counts.done).toBe(1);
  // The sidecar starts with a UTF-8 BOM so Notepad shows non-Latin text correctly.
  const sidecar = (await readFile(join(profile, 'downloads', '127.0.0.1', 'field-notes_info.txt'), 'utf8')).replace(/^\uFEFF/, '');
  expect(sidecar.split('\r\n').slice(0, 5)).toEqual([`Title: ${ITEMS[3].title}`, `Şifre: ${PASSWORD}`, `Author: ${ITEMS[3].author}`, `Tags: ${ITEMS[3].tag}`, `Date: ${ITEMS[3].date}`]);
});
