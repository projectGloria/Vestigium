import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DemoServer } from '../demo-site/server.js';
import type { Workflow } from '../../src/shared/types.js';
import { test, expect, call, finishedRun, logged, open, run, state, stopRecording } from './fixtures.js';

// Milestone 2 acceptance: a recorded click-through replays from its workflow JSON in a fresh tab.

// Moves the recorded tab away from the flow's pages and opens a blank tab, so the replay's tab is unambiguous.
async function freshTab(app: ElectronApplication, shell: Page, demo: DemoServer) {
  await open(app, shell, `${demo.origin}/`);
  await shell.getByRole('button', { name: 'New tab' }).click();
  await expect.poll(async () => {
    const current = await state(shell);
    return current.tabs.find(tab => tab.id === current.activeTabId)?.url;
  }).toBe('about:blank');
}

const replayPage = (app: ElectronApplication, url: string) =>
  expect.poll(() => app.context().pages().filter(page => page.url() === url).length).toBe(1)
    .then(() => app.context().pages().find(page => page.url() === url)!);

async function record(app: ElectronApplication, shell: Page, url: string, actions: (page: Page) => Promise<void>): Promise<Workflow> {
  const page = await open(app, shell, url);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await actions(page);
  return stopRecording(shell);
}

test('list → item → download replays in a fresh tab and reports which locator matched', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const workflow = await record(app, shell, `${demo.origin}/list`, async page => {
    await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
    await expect(page).toHaveURL(`${demo.origin}/item/1`);
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect.poll(() => logged(shell, 'Download requested (field-notes.zip)')).toBe(1);
  });
  // Since milestone 5 this recording repeats for every item on every page; one page and one item keep this a replay test.
  const pages = workflow.steps[1] as Extract<Workflow['steps'][number], { type: 'loop_pages' }>;
  const items = pages.params.steps[0];
  let edited = await shell.evaluate(([id, version, stepId]) => window.vestigium.updateWorkflow(id as string, version as number, { kind: 'set-max-pages', stepId: stepId as string, maxPages: 1 }),
    [workflow.id, workflow.version, pages.id] as const);
  if (!edited.ok) throw new Error(edited.error);
  edited = await shell.evaluate(([id, version, stepId]) => window.vestigium.updateWorkflow(id as string, version as number, { kind: 'set-max-items', stepId: stepId as string, maxItems: 1 }),
    [workflow.id, edited.state.selectedWorkflow!.version, items.id] as const);
  if (!edited.ok) throw new Error(edited.error);
  await freshTab(app, shell, demo);
  expect((await run(shell, workflow.id)).ok).toBe(true);
  const result = await finishedRun(shell);
  expect(result).toMatchObject({ workflowId: workflow.id, status: 'done', error: null, total: 2, current: null });
  expect(result.results.map(step => [step.status, step.label])).toEqual([
    ['done', `Open ${demo.origin}/list`],
    ['done', 'Page 1 › Item 1/10 › Download "field-notes.zip" by clicking link "Download ZIP"'],
    ['done', 'Page 1 › Repeat for every item'],
    ['done', 'Repeat on every page'],
  ]);
  expect(result.results[1].locator).toBe('role: link "Download ZIP"');
  expect(result.results[2].message).toBe('Opened 1 item; stopped at the limit of 1 item.');
  expect(await logged(shell, 'Download started: field-notes.zip')).toBe(1);
  expect(await logged(shell, 'Page 1 › Item 1/10 › Step 1/1 done: Download "field-notes.zip" by clicking link "Download ZIP" (matched role: link "Download ZIP")')).toBe(1);
});

test('the lab flow replays typing, select, shadow DOM, both iframes, SPA route and scroll; the password stays empty', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  let scrollTop = 0;
  const workflow = await record(app, shell, `${demo.origin}/lab`, async page => {
    await page.getByRole('textbox', { name: 'Search notes' }).click();
    await page.keyboard.type('notes', { delay: 15 });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${demo.origin}/lab?q=notes`);
    await page.getByRole('combobox', { name: 'Tag' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.getByLabel('Archive password').click();
    await page.keyboard.type('hunter2-never-recorded');
    await page.getByRole('button', { name: 'Shadow action' }).click();
    await page.frameLocator('iframe[title="Same-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
    await page.frameLocator('iframe[title="Cross-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
    await page.getByRole('link', { name: 'View two' }).click();
    await page.getByRole('region', { name: 'Scroll area' }).hover();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(700);
    scrollTop = await page.getByRole('region', { name: 'Scroll area' }).evaluate(element => Math.round(element.scrollTop));
  });
  expect(workflow.steps).toHaveLength(8);
  await freshTab(app, shell, demo);
  expect((await run(shell, workflow.id)).ok).toBe(true);
  const result = await finishedRun(shell);
  expect(result.status, result.error ?? '').toBe('done');
  expect(result.results.every(step => step.status === 'done')).toBe(true);

  const page = await replayPage(app, `${demo.origin}/lab/spa/two`);
  await expect(page.locator('#search-status')).toHaveText('Results for "notes"');
  await expect(page.locator('#tag-status')).toHaveText('Tag filter: architecture');
  await expect(page.getByText('Shadow clicked 1')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Same-origin frame"]').locator('#frame-status')).toHaveText('Frame clicked 1');
  await expect(page.frameLocator('iframe[title="Cross-origin frame"]').locator('#frame-status')).toHaveText('Frame clicked 1');
  await expect(page.locator('#spa-status')).toHaveText('SPA view: two');
  expect(await page.getByRole('region', { name: 'Scroll area' }).evaluate(element => Math.round(element.scrollTop))).toBe(scrollTop);
  await expect(page.getByLabel('Archive password')).toHaveValue('');
});

test('an auto-downloading popup replays: the popup alias is bound and its download is awaited', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const workflow = await record(app, shell, `${demo.origin}/item/1?variant=popup`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect.poll(() => logged(shell, 'Download requested (field-notes.zip)')).toBe(1);
  });
  await freshTab(app, shell, demo);
  const tabsBefore = (await state(shell)).tabs.length;
  expect((await run(shell, workflow.id)).ok).toBe(true);
  const result = await finishedRun(shell);
  expect(result.status, result.error ?? '').toBe('done');
  expect(result.results.map(step => step.status)).toEqual(['done', 'done']);
  expect((await state(shell)).tabs.length).toBe(tabsBefore + 1);
  expect(await logged(shell, 'Download started: field-notes.zip')).toBe(1);
});

test('a disabled countdown button is waited for, a run can be stopped, and recording is blocked while running', async ({ demo, launch }) => {
  test.setTimeout(90_000);
  const { app, shell } = await launch();
  // Each origin has its own cookie banner. Dismiss the file host's beforehand: a recorded banner click
  // would fail on replay once the banner stays dismissed (automatic banner handling is milestone 3).
  await open(app, shell, `${demo.hostOrigin}/countdown`);
  const workflow = await record(app, shell, `${demo.origin}/item/1?variant=countdown`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect(page).toHaveURL(/\/countdown\?/);
    // The server enforces five seconds; the button stays disabled until then.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  expect(workflow.steps.map(step => step.label)).toEqual([
    `Open ${demo.origin}/item/1?variant=countdown`,
    'Click link "Download ZIP"',
    expect.stringMatching(/^Download ".+" by clicking button "Continue"$/),
  ]);

  await freshTab(app, shell, demo);
  const started = Date.now();
  expect((await run(shell, workflow.id)).ok).toBe(true);
  expect(await call(shell, 'recordStart')).toEqual({ ok: false, error: 'Stop the running workflow before recording.' });
  expect(await run(shell, workflow.id)).toEqual({ ok: false, error: 'A workflow is already running. Stop it first.' });
  // Since milestone 8 the disabled button makes the run pause for you ("Needs you"), and it continues by itself once
  // the countdown ends; finishedRun() would return at the pause, so wait for the end itself.
  await expect.poll(async () => (await state(shell)).run?.status, { timeout: 30_000 }).toBe('done');
  // "not ready" (disabled) was waited for, not treated as a failure.
  expect(Date.now() - started).toBeGreaterThan(4000);
  expect(await logged(shell, 'Continuing: the page is ready again (countdown).')).toBe(1);

  // Stop while the run waits on the disabled button.
  expect((await run(shell, workflow.id)).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.current).toBe(2);
  expect((await call(shell, 'stopRun')).ok).toBe(true);
  const stopped = await finishedRun(shell);
  expect(stopped).toMatchObject({ status: 'stopped', error: 'Stopped by you.', current: null });
  expect(stopped.results.map(step => step.status)).toEqual(['done', 'done']);
  expect(await call(shell, 'stopRun')).toEqual({ ok: false, error: 'No workflow is running.' });
});

test('a step whose element is gone fails with a readable reason and never clicks a look-alike', async ({ demo, launch }, info) => {
  test.setTimeout(90_000);
  const { app, shell } = await launch();
  // After its first request, the "changing" list moves item 20 to the front, pushing item 10 off page 1.
  await open(app, shell, `${demo.origin}/list?dataset=changing`);
  // Since milestone 5 a recorded click on a list item becomes an item loop, so the single click this test needs is
  // imported instead, with the locators the recorder captures for it: the identity (role) and a position (xpath).
  const plain: Workflow = {
    schemaVersion: 1, id: 'look-alike', name: 'Open item 10', siteProfileId: null, variables: {}, createdAt: new Date().toISOString(), version: 1,
    steps: [
      { id: 's1', type: 'navigate', label: `Open ${demo.origin}/list?dataset=changing`, enabled: true, locators: [], params: { url: `${demo.origin}/list?dataset=changing` },
        target: { tab: 'main', frames: [], shadowHosts: [] }, waitFor: null, timeoutMs: 30_000, onFail: 'retry' },
      { id: 's2', type: 'click', label: 'Click link "Field Notes 10"', enabled: true, params: {},
        locators: [
          { strategy: 'role', value: 'link "Field Notes 10"', confidence: 0.9 },
          { strategy: 'xpath', value: '/html[1]/body[1]/div[1]/main[1]/section[1]/article[10]/h3[1]/a[1]', confidence: 0.3 },
        ],
        target: { tab: 'main', frames: [], shadowHosts: [] }, waitFor: { navigation: true }, timeoutMs: 15_000, onFail: 'retry' },
    ],
  };
  const path = info.outputPath('look-alike.json');
  await writeFile(path, JSON.stringify(plain, null, 2));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
  const imported = await shell.evaluate(() => window.vestigium.importWorkflow());
  if (!imported.ok) throw new Error(imported.error);
  const workflow = imported.state.selectedWorkflow!;
  await freshTab(app, shell, demo);
  expect((await run(shell, workflow.id)).ok).toBe(true);
  const result = await finishedRun(shell);
  expect(result.status).toBe('failed');
  // The 10th card's position still exists (now holding item 9); its positional locators were refused, and the reason says so.
  expect(result.error).toBe('Step 2/2 failed: Click link "Field Notes 10". No recorded locator matched exactly one element. '
    + 'A position-based match was rejected: it is link "Field Notes 09", not the recorded link "Field Notes 10". Waited 15 s.');
  expect(result.results.map(step => step.status)).toEqual(['done', 'failed']);
  // Still on the list: no other card was opened in its place.
  await replayPage(app, `${demo.origin}/list?dataset=changing`);
  // The recorded tab was moved to the index; no tab is on any item page.
  expect(app.context().pages().filter(page => /\/item\/\d+$/.test(page.url())).map(page => page.url())).toEqual([]);
});
