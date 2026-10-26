import { test, expect, call, open, state, stopRecording as stop } from './fixtures.js';
import type { Step } from '../../src/shared/types.js';

// Records real user flows in the real app: Playwright input is trusted, the recorder preload runs in the
// isolated world of every frame, and the workflow comes back through the shell bridge.

const labels = (steps: Step[]) => steps.map(step => step.label);

test('recording list → item → download yields a readable, persisted workflow', async ({ demo, launch }) => {
  let { app, shell } = await launch();
  const list = await open(app, shell, `${demo.origin}/list`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  expect(await call(shell, 'recordStart')).toEqual({ ok: false, error: 'A recording is already running.' });
  await list.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await expect(list).toHaveURL(`${demo.origin}/item/1`);
  await list.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(async () => (await state(shell)).logs.some(entry => entry.message.startsWith('Download requested (field-notes.zip)'))).toBe(true);
  const workflow = await stop(shell);

  // Since milestone 5 the opened item is recognized as one of the list's items, so the recording is generalized:
  // the list, then every page, then every item (run by tests/electron/items.spec.ts).
  expect(labels(workflow.steps)).toEqual([`Open ${demo.origin}/list`, 'Repeat on every page']);
  const pages = workflow.steps[1] as Extract<Step, { type: 'loop_pages' }>;
  expect(labels(pages.params.steps)).toEqual(['Repeat for every item']);
  const items = pages.params.steps[0] as Extract<Step, { type: 'loop_items' }>;
  expect(labels(items.params.steps)).toEqual(['Download "field-notes.zip" by clicking link "Download ZIP"']);
  const download = items.params.steps[0];
  expect(download).toMatchObject({ type: 'download', params: { filename: 'field-notes.zip', mimeType: 'application/zip' }, waitFor: { download: true } });
  expect(download.locators.length).toBeGreaterThanOrEqual(3);
  expect(download.locators[0]).toMatchObject({ strategy: 'role', value: 'link "Download ZIP"' });
  expect(download.target).toEqual({ tab: 'item', frames: [], shadowHosts: [] });
  expect(workflow.name).toMatch(/^Recording · 127\.0\.0\.1:\d+ · \d{4}-\d\d-\d\d \d\d:\d\d$/);

  // Saved to SQLite: still listed after a full restart.
  await app.close();
  ({ app, shell } = await launch());
  expect((await state(shell)).workflows).toEqual([{ id: workflow.id, name: workflow.name, steps: 2, createdAt: workflow.createdAt }]);
});

test('recording the lab captures typing, select, shadow DOM, both iframes, SPA routes and scroll, but no password', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const page = await open(app, shell, `${demo.origin}/lab`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);

  await page.getByRole('textbox', { name: 'Search notes' }).click();
  await page.keyboard.type('notes', { delay: 15 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${demo.origin}/lab?q=notes`);
  await expect(page.locator('#search-status')).toHaveText('Results for "notes"');
  // The reloaded document re-arms itself: its preload reports ready and main arms it.
  await page.getByRole('combobox', { name: 'Tag' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.getByLabel('Archive password').click();
  await page.keyboard.type('hunter2-never-recorded');
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await page.frameLocator('iframe[title="Same-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
  await page.frameLocator('iframe[title="Cross-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
  await page.getByRole('link', { name: 'View two' }).click();
  await expect(page).toHaveURL(`${demo.origin}/lab/spa/two`);
  await page.getByRole('region', { name: 'Scroll area' }).hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(700); // scroll settles after 400 ms
  const workflow = await stop(shell);

  const hostPort = new URL(demo.hostOrigin).host;
  const originHost = new URL(demo.origin).host;
  const scrollTop = await page.getByRole('region', { name: 'Scroll area' }).evaluate(element => Math.round(element.scrollTop));
  expect(labels(workflow.steps)).toEqual([
    `Open ${demo.origin}/lab`,
    'Type "notes" into "Search notes" and press Enter',
    'Select "Architecture" in "Tag"',
    'Click button "Shadow action" (inside a web component)',
    `Click button "Frame action" (inside a frame from ${originHost})`,
    `Click button "Frame action" (inside a frame from ${hostPort})`,
    'Click link "View two"',
    `Scroll region "Scroll area" to 0, ${scrollTop}`,
  ]);
  expect(workflow.steps[1]).toMatchObject({ params: { value: 'notes', key: 'Enter' }, waitFor: { navigation: true } });
  expect(workflow.steps[3].target.shadowHosts).toEqual(['lab-widget']);
  expect(workflow.steps[4].target.frames).toEqual([{ url: `${demo.origin}/lab/frame?label=Same-origin`, name: '', index: 0 }]);
  expect(workflow.steps[5].target.frames).toEqual([{ url: `${demo.hostOrigin}/lab/frame?label=Cross-origin`, name: '', index: 1 }]);
  expect(workflow.steps[6].waitFor).toEqual({ navigation: true });
  const serialized = JSON.stringify(workflow);
  expect(serialized).not.toContain('hunter2');
  expect(serialized).not.toContain('Archive password');
  expect((await state(shell)).logs.some(entry => entry.message === 'Skipped a password or payment field; nothing typed into it was recorded.')).toBe(true);
});

test('a download that starts by itself in a popup is recorded on the click that opened the popup', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const item = await open(app, shell, `${demo.origin}/item/1?variant=popup`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await item.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(async () => (await state(shell)).logs.some(entry => entry.message.startsWith('Download requested (field-notes.zip)'))).toBe(true);
  const workflow = await stop(shell);
  expect(labels(workflow.steps)).toEqual([
    `Open ${demo.origin}/item/1?variant=popup`,
    'Download "field-notes.zip" by clicking link "Download ZIP", which opens popup-1',
  ]);
  expect(workflow.steps[1].params).toEqual({ filename: 'field-notes.zip', mimeType: 'application/zip', opensTab: 'popup-1' });
  expect((await state(shell)).tabs).toHaveLength(2);
});

test('an empty recording is refused with a readable reason, and other tabs are not recorded', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const first = await open(app, shell, `${demo.origin}/lab`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  // Input in a tab that was not recorded (opened by the shell, not by a recorded click) is ignored.
  await shell.getByRole('button', { name: 'New tab' }).click();
  const second = await open(app, shell, `${demo.origin}/list`);
  await second.getByRole('link', { name: 'Field Notes 02', exact: true }).click();
  await expect(second).toHaveURL(`${demo.origin}/item/2`);
  expect(first.isClosed()).toBe(false);
  const result = await call(shell, 'recordStop');
  // Only the start URL was recorded, which is a valid one-step workflow; the other tab added nothing.
  expect(result.ok && labels(result.state.selectedWorkflow!.steps)).toEqual([`Open ${demo.origin}/lab`]);

  await shell.getByRole('button', { name: 'New tab' }).click();
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  expect(await call(shell, 'recordStop')).toEqual({
    ok: false, error: 'Nothing was recorded. Start recording, then click, type or download on the page.',
  });
  expect((await state(shell)).recording).toEqual({ active: false, events: 0 });
});
