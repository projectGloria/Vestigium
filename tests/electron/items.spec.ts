import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DemoServer } from '../demo-site/server.js';
import type { Result } from '../../src/shared/ipc.js';
import type { RunMode, RunSettings, RunState, Step, Workflow } from '../../src/shared/types.js';
import { ITEMS } from '../demo-site/fixtures.js';
import { test, expect, call, finishedRun, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 5: after teaching ONE item, every item on the list is found and highlighted, and a run opens every item
// on every page (plan acceptance: "teach one item … Start downloads every item on every page and stops by itself").

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };
const DOWNLOAD = 'Download "field-notes.zip" by clicking link "Download ZIP"';
type LoopPages = Extract<Step, { type: 'loop_pages' }>;
type LoopItems = Extract<Step, { type: 'loop_items' }>;

const panel = (shell: Page) => shell.getByRole('region', { name: 'Workflow' });
const runAs = (shell: Page, id: string, mode: RunMode = 'run') =>
  shell.evaluate(([workflow, how]) => window.vestigium.runWorkflow(workflow, how as RunMode), [id, mode] as const) as Promise<Result>;

// Records: open `url`, open the item called `title`, click its download link.
async function teach(app: ElectronApplication, shell: Page, url: string, title: string) {
  const page = await open(app, shell, url);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page).not.toHaveURL(url);
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested (field-notes.zip)')).toBe(1);
  return stopRecording(shell);
}

async function freshTab(app: ElectronApplication, shell: Page, demo: DemoServer) {
  await open(app, shell, `${demo.origin}/`);
  await shell.getByRole('button', { name: 'New tab' }).click();
}

async function crawl(shell: Page, id: string, mode: RunMode = 'run', timeout = 240_000) {
  expect((await runAs(shell, id, mode)).ok).toBe(true);
  const run = await finishedRun(shell, timeout);
  expect(run.status, run.error ?? '').toBe('done');
  return run;
}

const messages = (run: RunState, step: Step) => run.results.filter(result => result.stepId === step.id).map(result => result.message);
const downloads = (run: RunState) => run.results.filter(result => result.status === 'done' && result.label.endsWith(DOWNLOAD)).map(result => result.label);

test('teach one item, press Run: all 47 items on all 5 pages are opened and downloaded, then the run stops by itself', async ({ demo, launch, profile }, info) => {
  test.setTimeout(300_000);
  const { app, shell } = await launch();
  const workflow = await teach(app, shell, `${demo.origin}/list`, 'Field Notes 03');

  // Generalized without any editing: open the list → every page → every item → the download.
  expect(workflow.steps.map(step => step.type)).toEqual(['navigate', 'loop_pages']);
  const pages = workflow.steps[1] as LoopPages;
  expect(pages.params.pagination.kind).toBe('next');
  const items = pages.params.steps[0] as LoopItems;
  expect(items.type).toBe('loop_items');
  expect(items.params.pattern).toMatchObject({ parent: 'main', container: 'section', item: 'article', link: 'h3 > a' });
  expect(items.params.steps.map(step => [step.type, step.target.tab, step.label])).toEqual([['download', 'item', DOWNLOAD]]);
  expect(await logged(shell, 'Found 10 items on the list (you opened number 3).')).toBe(1);

  // The plain-language summary (plan §1) shows what was understood.
  const summary = panel(shell).getByRole('note', { name: 'What this workflow does' });
  await expect(summary).toContainText('Page type: LIST. Each item is a card (<article> in <section>), opened through its link (h3 > a).');
  await expect(summary).toContainText(`Open each item → ${DOWNLOAD} (file type ZIP).`);
  await expect(summary).toContainText('Next page: the link "Next →" (rel=next, text "Next →").');
  await shell.screenshot({ path: info.outputPath('generalized-workflow.png') });

  await freshTab(app, shell, demo);
  const tabsBefore = (await state(shell)).tabs.length;
  const run = await crawl(shell, workflow.id);
  expect(messages(run, pages)).toEqual(['Visited 5 pages (47 content links). Stopped because the next control is missing.']);
  expect(messages(run, items)).toEqual(['Opened 10 items.', 'Opened 10 items.', 'Opened 10 items.', 'Opened 10 items.', 'Opened 7 items.']);
  const done = downloads(run);
  expect(done).toHaveLength(47);
  expect(done[0]).toBe(`Page 1 › Item 1/10 › ${DOWNLOAD}`);
  expect(done[46]).toBe(`Page 5 › Item 7/7 › ${DOWNLOAD}`);
  // Since milestone 6 every download is fetched by the queue. All 47 demo items serve the same ZIP bytes, so one file
  // is kept and 46 jobs are recorded as identical copies (hash dedupe), each tied to its own item.
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 60_000 }).toBe(47);
  const rows = (await state(shell)).downloads.rows;
  expect(rows.filter(row => row.duplicateOf !== null)).toHaveLength(46);
  // Since milestone 7 each kept file has its _info.txt sidecar.
  expect(await readdir(join(profile, 'downloads', '127.0.0.1'))).toEqual(['field-notes.zip', 'field-notes_info.txt']);
  // Each item was its own page, in list order.
  const opened = (await state(shell)).logs.filter(entry => entry.message.startsWith('Repeat for every item · ')).map(entry => entry.message);
  expect(opened.at(-1)).toBe(`Repeat for every item · Page 5 · Item 7 of 7: ${ITEMS[46].title}.`);
  // The item tab is closed again and the list is the visible tab.
  const after = await state(shell);
  expect(after.tabs).toHaveLength(tabsBefore);
  expect(after.tabs.find(tab => tab.id === after.activeTabId)!.url).toBe(`${demo.origin}/list?page=5`);
});

test('show the items on the page, exclude one, dry-run, then run two pages of a list with duplicates', async ({ demo, launch }, info) => {
  test.setTimeout(240_000);
  const { app, shell } = await launch();
  const workflow = await teach(app, shell, `${demo.origin}/list?dataset=duplicates`, 'Field Notes 01');
  const items = (workflow.steps[1] as LoopPages).params.steps[0] as LoopItems;

  // The active tab is on the item page; "Show items" opens the list again and highlights what it found.
  await panel(shell).getByRole('button', { name: '◎ Show items on the page' }).click();
  const found = panel(shell).getByRole('list', { name: 'Items found for step 2.1' });
  await expect(found.getByRole('checkbox')).toHaveCount(10);
  await expect(found.getByRole('listitem').first()).toHaveText(ITEMS[0].title);
  await expect(found.getByRole('listitem').last()).toHaveText(ITEMS[9].title);
  expect(await logged(shell, 'Found 10 items on the list; 10 are highlighted on the page.')).toBe(1);
  const list = app.context().pages().find(page => page.url() === `${demo.origin}/list?dataset=duplicates`)!;
  await list.screenshot({ path: info.outputPath('items-highlighted.png') });

  // Untick item 2: stored in the workflow, and the page marks it as excluded.
  await found.getByRole('checkbox', { name: ITEMS[1].title }).uncheck();
  await expect(panel(shell)).toContainText('9 of 10 items on this page will be opened.');
  await expect.poll(async () => ((await state(shell)).selectedWorkflow!.steps[1] as LoopPages).params.steps[0])
    .toMatchObject({ params: { exclude: [`${demo.origin}/item/2`] } });
  await expect(panel(shell).getByRole('note', { name: 'What this workflow does' })).toContainText('1 item is excluded.');
  await panel(shell).getByRole('button', { name: 'Hide items' }).click();
  await expect(found).toBeHidden();
  await expect(panel(shell).getByLabel('Loop of step 2.1')).toContainText('1 excluded');

  const limit = panel(shell).getByRole('spinbutton', { name: 'Maximum pages for step 2' });
  await limit.fill('2');
  await limit.press('Enter');
  await expect.poll(async () => ((await state(shell)).selectedWorkflow!.steps[1] as LoopPages).params.maxPages).toBe(2);

  // Dry run: the items are found and highlighted, none is opened.
  let run = await crawl(shell, workflow.id, 'dry');
  expect(messages(run, items)).toEqual([`Found 10 items, 9 to open (1 excluded by you); highlighted, not opened (dry run). First: "${ITEMS[0].title}".`]);
  expect(downloads(run)).toEqual([]);

  // Page 2 repeats items 9 and 10: they are not opened twice.
  run = await crawl(shell, workflow.id);
  expect(messages(run, items)).toEqual(['Opened 9 items (1 excluded by you).', 'Opened 8 items (2 already done earlier in this run).']);
  expect(downloads(run)).toHaveLength(17);
  expect(messages(run, workflow.steps[1])).toEqual(['Visited 2 pages (18 content links). Stopped because reached the limit of 2 pages.']);
});

test('one broken item is reported and skipped; the item limit ends the whole crawl', async ({ demo, launch }, info) => {
  test.setTimeout(240_000);
  const { app, shell } = await launch();
  const taught = await teach(app, shell, `${demo.origin}/list?broken=3`, 'Field Notes 01');
  // A short timeout keeps the broken item quick (the default download timeout is 60 s); imported like a user would.
  const edited: Workflow = structuredClone(taught);
  const loop = (edited.steps[1] as LoopPages).params.steps[0] as LoopItems;
  loop.params.steps[0].timeoutMs = 3000;
  (edited.steps[1] as LoopPages).params.maxPages = 1;
  const path = info.outputPath('broken.json');
  await writeFile(path, JSON.stringify(edited, null, 2));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
  const imported = await shell.evaluate(() => window.vestigium.importWorkflow());
  if (!imported.ok) throw new Error(imported.error);
  const workflow = imported.state.selectedWorkflow!;
  const items = (workflow.steps[1] as LoopPages).params.steps[0] as LoopItems;

  await freshTab(app, shell, demo);
  let run = await crawl(shell, workflow.id);
  const failed = run.results.filter(result => result.status === 'failed');
  // The step that failed, then the item it belongs to.
  expect(failed.map(result => result.label)).toEqual([`Page 1 › Item 3/10 › ${DOWNLOAD}`, `Page 1 › Item 3/10 › ${ITEMS[2].title} · Repeat for every item`]);
  expect(failed[0].message).toMatch(/ Waited 3 s\.$/);
  expect(failed[1].message).toMatch(/^Page 1 › Item 3\/10 › Step 1\/1 failed: Download "field-notes\.zip" by clicking link "Download ZIP"\. /);
  expect(messages(run, items).at(-1)).toMatch(new RegExp(`^Opened 9 items; 1 failed \\("${ITEMS[2].title}": Page 1 › Item 3/10 › Step 1/1 failed: `));
  expect(downloads(run)).toHaveLength(9);
  expect(await logged(shell, `Item "${ITEMS[2].title}" failed: `)).toBe(1);

  // The first run downloaded 9 items; a new run would skip them. Force downloads them again, so the limit is visible.
  expect((await shell.evaluate(() => window.vestigium.setDownloadOptions({ concurrency: 3, retries: 4, force: true, template: '{site}/{filename}', sidecar: true, extract: 'off' }))).ok).toBe(true);
  // An item limit of 2, set in the UI, ends the page loop too.
  const field = panel(shell).getByRole('spinbutton', { name: 'Maximum items for step 2.1' });
  await field.fill('2');
  await field.press('Enter');
  await expect.poll(async () => (((await state(shell)).selectedWorkflow!.steps[1] as LoopPages).params.steps[0] as LoopItems).params.maxItems).toBe(2);
  run = await crawl(shell, workflow.id);
  expect(messages(run, items)).toEqual(['Opened 2 items; stopped at the limit of 2 items.']);
  expect(messages(run, workflow.steps[1])).toEqual(['Visited 1 page (10 content links). Stopped because the item limit was reached.']);
});

test('a crawl keeps working while the window is minimized: clicks fall back to in-page input', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  const workflow = await teach(app, shell, `${demo.origin}/list`, 'Field Notes 01');
  const pages = workflow.steps[1] as LoopPages;
  const items = pages.params.steps[0] as LoopItems;
  // Two pages, two items on the second: page 2 creates a fresh item tab while the window is minimized.
  const edit = (version: number, change: object) =>
    shell.evaluate(([id, at, what]) => window.vestigium.updateWorkflow(id as string, at as number, what as never), [workflow.id, version, change] as const);
  expect((await edit(workflow.version, { kind: 'set-max-pages', stepId: pages.id, maxPages: 2 })).ok).toBe(true);
  expect((await edit(workflow.version + 1, { kind: 'set-max-items', stepId: items.id, maxItems: 12 })).ok).toBe(true);
  await freshTab(app, shell, demo);
  // Chromium keeps tabs created while minimized at a 0×0 viewport, where OS-level clicks hit nothing: before the
  // fallback, every item waited out its 60 s download timeout.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  const run = await crawl(shell, workflow.id, 'run', 90_000);
  expect(messages(run, items)).toEqual(['Opened 10 items.', 'Opened 2 items; stopped at the limit of 12 items.']);
  expect(downloads(run)).toHaveLength(12);
  expect(await logged(shell, 'The Vestigium window is minimized, so clicks are performed inside the page')).toBe(1);
});
