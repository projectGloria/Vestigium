import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Result } from '../../src/shared/ipc.js';
import type { RunMode, RunSettings, Step, Workflow } from '../../src/shared/types.js';
import { test, expect, call, finishedRun, open, state, stopRecording } from './fixtures.js';

// Milestone 4: paginated, load-more, infinite-scroll and SPA lists are crawled fully and stop correctly.

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };
type Loop = Extract<Step, { type: 'loop_pages' }>;

const runAs = (shell: Page, id: string, mode: RunMode = 'run') =>
  shell.evaluate(([workflow, how]) => window.vestigium.runWorkflow(workflow, how as RunMode), [id, mode] as const) as Promise<Result>;
const learn = (shell: Page, workflow: Workflow) =>
  shell.evaluate(([id, version]) => window.vestigium.learnPages(id as string, version as number), [workflow.id, workflow.version] as const) as Promise<Result>;

// Records a workflow that starts on `url` and scrolls the window once (a step that will repeat on every page).
async function recordList(app: ElectronApplication, shell: Page, url: string) {
  const page = await open(app, shell, url);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(700);
  return { page, workflow: await stopRecording(shell) };
}

async function learned(shell: Page, workflow: Workflow) {
  const result = await learn(shell, workflow);
  if (!result.ok) throw new Error(result.error);
  const updated = result.state.selectedWorkflow!;
  expect(updated.steps.map(step => step.type)).toEqual(['navigate', 'loop_pages']);
  return { workflow: updated, loop: updated.steps[1] as Loop };
}

async function crawl(shell: Page, workflow: Workflow, mode: RunMode = 'run') {
  expect((await runAs(shell, workflow.id, mode)).ok).toBe(true);
  const run = await finishedRun(shell, 120_000);
  expect(run.status, run.error ?? '').toBe('done');
  return run;
}

const loopResult = (run: Awaited<ReturnType<typeof crawl>>, loop: Loop) => run.results.find(result => result.stepId === loop.id)!.message;

for (const layout of ['cards', 'table']) {
  test(`numbered pages (${layout}): the Next link is followed to the last page`, async ({ demo, launch }) => {
    test.setTimeout(120_000);
    const { app, shell } = await launch();
    const { workflow } = await recordList(app, shell, `${demo.origin}/list?layout=${layout}`);
    expect(workflow.steps.map(step => step.label)).toEqual([`Open ${demo.origin}/list?layout=${layout}`, 'Scroll the page to 0, 300']);
    const { workflow: looped, loop } = await learned(shell, workflow);
    expect(loop.params.pagination).toMatchObject({ kind: 'next', description: expect.stringMatching(/^Next page: the link "Next →" \(rel=next, text "Next →"\)\./) });
    const run = await crawl(shell, looped);
    expect(loopResult(run, loop)).toBe('Visited 5 pages (47 content links). Stopped because the next control is missing.');
    // The recorded scroll ran once per page, inside the loop.
    expect(run.results.filter(result => result.label.endsWith('Scroll the page to 0, 300')).map(result => result.label.split(' › ')[0]))
      .toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
  });
}

test('load more and infinite scroll grow one list until nothing new arrives', async ({ demo, launch }) => {
  test.setTimeout(180_000);
  const { app, shell } = await launch();
  let { workflow } = await recordList(app, shell, `${demo.origin}/list?mode=more`);
  let { workflow: looped, loop } = await learned(shell, workflow);
  expect(loop.params.pagination).toMatchObject({ kind: 'load-more', description: 'More items: press the button "Load more". Stops when it is missing or disabled, or when it loads nothing new.' });
  let run = await crawl(shell, looped);
  expect(loopResult(run, loop)).toBe('Visited 5 pages (47 content links). Stopped because the "load more" control is disabled.');

  ({ workflow } = await recordList(app, shell, `${demo.origin}/list?mode=infinite`));
  ({ workflow: looped, loop } = await learned(shell, workflow));
  expect(loop.params.pagination.kind).toBe('infinite-scroll');
  run = await crawl(shell, looped);
  expect(loopResult(run, loop)).toBe('Visited 5 pages (47 content links). Stopped because scrolling to the bottom loaded nothing new.');
});

test('an SPA list (content changes, URL does not) and a list whose last page wraps back to page 1', async ({ demo, launch }) => {
  test.setTimeout(180_000);
  const { app, shell } = await launch();
  let { workflow } = await recordList(app, shell, `${demo.origin}/list?mode=spa`);
  let { workflow: looped, loop } = await learned(shell, workflow);
  expect(loop.params.pagination).toMatchObject({ kind: 'next', description: expect.stringContaining('the button "Next ›"') });
  let run = await crawl(shell, looped);
  expect(loopResult(run, loop)).toBe('Visited 5 pages (47 content links). Stopped because the next control is disabled.');
  const current = await state(shell);
  expect(current.tabs.find(tab => tab.id === current.activeTabId)!.url).toBe(`${demo.origin}/list?mode=spa`);

  ({ workflow } = await recordList(app, shell, `${demo.origin}/list?wrap=1`));
  ({ workflow: looped, loop } = await learned(shell, workflow));
  run = await crawl(shell, looped);
  expect(loopResult(run, loop)).toBe('Visited 6 pages (47 content links). Stopped because page 6 repeats an earlier page.');
});

test('the page limit, duplicates, a URL pattern and a dry run all stop where they should', async ({ demo, launch }, info) => {
  test.setTimeout(240_000);
  const { app, shell } = await launch();
  const { workflow } = await recordList(app, shell, `${demo.origin}/list?dataset=duplicates`);
  const { workflow: looped, loop } = await learned(shell, workflow);

  // Duplicated items (9 and 10 reappear on page 2) are counted once.
  let run = await crawl(shell, looped);
  expect(loopResult(run, loop)).toBe('Visited 5 pages (47 content links). Stopped because the next control is missing.');

  // A page limit set in the UI.
  const limit = shell.getByRole('spinbutton', { name: 'Maximum pages for step 2' });
  await limit.fill('2');
  await limit.press('Enter');
  await expect.poll(async () => ((await state(shell)).selectedWorkflow!.steps[1] as Loop).params.maxPages).toBe(2);
  run = await crawl(shell, (await state(shell)).selectedWorkflow!);
  // Page 2 repeats items 9 and 10, so two pages hold 18 distinct links.
  expect(loopResult(run, loop)).toBe('Visited 2 pages (18 content links). Stopped because reached the limit of 2 pages.');

  // Dry run: the first page is checked, nothing is advanced.
  run = await crawl(shell, (await state(shell)).selectedWorkflow!, 'dry');
  expect(loopResult(run, loop)).toMatch(/^Visited 1 page \(10 content links\)\. Stopped because dry run: would continue with Next page: /);

  // A URL pattern (as learned from numbered links when there is no Next control): page 6 is empty.
  const urlVariant = structuredClone(looped);
  (urlVariant.steps[1] as Loop).params.pagination = { kind: 'url', template: `${demo.origin}/list?page={{page}}`, description: 'Next page: open the URL with the next page number.' };
  const path = info.outputPath('url.json');
  await writeFile(path, JSON.stringify(urlVariant, null, 2));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
  const imported = await shell.evaluate(() => window.vestigium.importWorkflow());
  if (!imported.ok) throw new Error(imported.error);
  run = await crawl(shell, imported.state.selectedWorkflow!);
  expect(loopResult(run, imported.state.selectedWorkflow!.steps[1] as Loop)).toBe('Visited 6 pages (47 content links). Stopped because page 6 brought no new links.');
});

test('learning refuses a page without pagination; on the last page it falls back to the URL pattern; the UI button works', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const { workflow } = await recordList(app, shell, `${demo.origin}/item/1`);
  expect(await learn(shell, workflow)).toEqual({
    ok: false,
    error: 'No pagination found on this page: no next link or button, no numbered pages, no "Load more" button, and scrolling to the bottom loaded nothing new.',
  });
  // On the last page the Next control is disabled, but the numbered links still reveal the URL pattern.
  const { workflow: lastPage } = await recordList(app, shell, `${demo.origin}/list?page=5`);
  const fromLast = await learned(shell, lastPage);
  expect(fromLast.loop.params.pagination).toMatchObject({ kind: 'url', template: `${demo.origin}/list?page={{page}}` });

  await shell.getByRole('navigation', { name: 'Saved workflows' }).getByRole('button').last().click();
  await expect.poll(async () => (await state(shell)).selectedWorkflow?.id).toBe(workflow.id);
  await open(app, shell, `${demo.origin}/list`);
  await shell.getByRole('button', { name: '↻ Repeat on every page' }).click();
  const panel = shell.getByRole('region', { name: 'Workflow' });
  await expect(panel.getByLabel('Loop of step 2')).toContainText('Next page: the link "Next →"');
  await expect(panel.getByRole('list', { name: 'Steps repeated on every page (step 2)' }).getByRole('listitem')).toHaveCount(1);
  await expect(shell.getByRole('button', { name: '↻ Repeat on every page' })).toBeHidden();
});
