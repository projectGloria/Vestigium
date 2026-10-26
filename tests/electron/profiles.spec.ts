import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import type { RunSettings, RunState, Step, Workflow } from '../../src/shared/types.js';
import { test, expect, call, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 8: site profiles (teach once, then a URL and Start), re-teaching one broken step, failure screenshots,
// persistent run history, the safety pauses of plan §7, the clipboard link, and minimizing to the tray.

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };
type LoopPages = Extract<Step, { type: 'loop_pages' }>;
test.use({ demoOptions: { largeBytes: 4 << 20 } });
const panel = (shell: Page) => shell.getByRole('region', { name: 'Site profiles' });

async function teach(app: ElectronApplication, shell: Page, url: string, actions: (page: Page) => Promise<void>): Promise<Workflow> {
  const page = await open(app, shell, url);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await actions(page);
  return stopRecording(shell);
}

const ended = async (shell: Page, timeout = 60_000): Promise<RunState> => {
  await expect.poll(async () => (await state(shell)).run?.status, { timeout }).toMatch(/^(done|failed|stopped)$/);
  return (await state(shell)).run!;
};

test('teach a site once; later a list URL and Start are enough, and the profile records how it went', async ({ demo, launch, profile }) => {
  test.setTimeout(180_000);
  let { app, shell } = await launch();
  const workflow = await teach(app, shell, `${demo.origin}/list`, async page => {
    await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  const host = new URL(demo.origin).host;
  expect(await logged(shell, `Saved a site profile for ${host}: next time, open a ${host} list and press Start; no teaching needed.`)).toBe(1);
  expect((await state(shell)).selectedWorkflow!.siteProfileId).toBeTruthy();
  // Keep the run short: one page, three items.
  const pages = workflow.steps[1] as LoopPages;
  let current = (await state(shell)).selectedWorkflow!;
  for (const change of [{ kind: 'set-max-pages', stepId: pages.id, maxPages: 1 }, { kind: 'set-max-items', stepId: pages.params.steps[0].id, maxItems: 3 }]) {
    const result = await shell.evaluate(([id, at, what]) => window.vestigium.updateWorkflow(id as string, at as number, what as never), [current.id, current.version, change] as const);
    if (!result.ok) throw new Error(result.error);
    current = result.state.selectedWorkflow!;
  }

  // After a restart: open another list of the same site and press Start in the toolbar.
  await app.close();
  ({ app, shell } = await launch());
  await expect(panel(shell).getByRole('listitem', { name: `Site profile ${host}` })).toContainText('not run yet');
  await open(app, shell, `${demo.origin}/list?dataset=duplicates`);
  await shell.getByRole('banner').getByRole('button', { name: '▶ Start', exact: true }).click();
  const run = await ended(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results[0].label).toBe(`Open ${demo.origin}/list?dataset=duplicates`);
  expect(run.results.find(result => result.label === 'Page 1 › Repeat for every item')!.message).toBe('Opened 3 items; stopped at the limit of 3 items.');
  await expect.poll(async () => (await state(shell)).downloads.counts.done).toBe(3);
  await expect(panel(shell).getByRole('listitem', { name: `Site profile ${host}` })).toContainText('Working');
  await expect(panel(shell).getByRole('listitem', { name: `Site profile ${host}` })).toContainText('last worked');
  // The run is in the persistent history.
  expect((await state(shell)).history.map(record => [record.workflowName, record.status, record.failed])).toEqual([[workflow.name, 'done', 0]]);
  void profile;
});

test('a broken step: the run fails with a screenshot; "Re-teach this step" records only that step and the next run works', async ({ demo, launch }, info) => {
  test.setTimeout(180_000);
  let { app, shell } = await launch();
  const taught = await teach(app, shell, `${demo.origin}/item/1`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  // The site changed beyond healing: the download step's locators point at nothing (imported like a user would).
  const broken: Workflow = structuredClone(taught);
  broken.steps[1].locators = [{ strategy: 'css', value: '#gone-for-good', confidence: 0.9 }];
  broken.steps[1].timeoutMs = 2000;
  broken.steps[1].onFail = 'abort';
  const path = info.outputPath('broken.json');
  await writeFile(path, JSON.stringify(broken, null, 2));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog; }, path);
  const imported = await shell.evaluate(() => window.vestigium.importWorkflow());
  if (!imported.ok) throw new Error(imported.error);
  const workflow = imported.state.selectedWorkflow!;

  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  let run = await ended(shell);
  expect(run.status).toBe('failed');
  expect(run.failure).toEqual({ stepId: workflow.steps[1].id, label: workflow.steps[1].label, url: `${demo.origin}/item/1` });
  const failed = run.results.find(result => result.status === 'failed')!;
  expect(failed.screenshot).toMatch(/^[0-9a-f-]{36}\.png$/);

  // History survives a restart, with the screenshot.
  await app.close();
  ({ app, shell } = await launch());
  const [record] = (await state(shell)).history;
  expect(record).toMatchObject({ workflowId: workflow.id, status: 'failed', failed: 1, failure: { stepId: workflow.steps[1].id } });
  expect(record.failures[0].screenshot).toBe(failed.screenshot);
  await shell.getByRole('tab', { name: 'History' }).click();
  await expect(shell.getByRole('list', { name: 'Earlier runs' })).toContainText(`${workflow.name}`);

  // Re-teach from the step list: it opens the failing page, records one click, and replaces only that step.
  expect((await shell.evaluate(id => window.vestigium.selectWorkflow(id), workflow.id)).ok).toBe(true);
  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  run = await ended(shell);
  const step = shell.getByRole('listitem', { name: 'Step 2', exact: true });
  await step.getByRole('button', { name: '↻ Re-teach this step' }).click();
  await expect(shell.getByRole('region', { name: 'Workflow' })).toContainText(`Re-teaching "${workflow.steps[1].label}"`);
  const page = app.context().pages().find(candidate => candidate.url() === `${demo.origin}/item/1`)!;
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested')).toBeGreaterThan(0);
  await shell.getByRole('button', { name: /^■ Stop recording/ }).click();
  await expect.poll(() => logged(shell, `Re-taught "${workflow.steps[1].label}": it now finds role: link "Download ZIP".`)).toBe(1);
  const fixed = (await state(shell)).selectedWorkflow!;
  expect(fixed.id).toBe(workflow.id);
  expect(fixed.steps.map(candidate => candidate.id)).toEqual(workflow.steps.map(candidate => candidate.id));
  expect(fixed.steps[1].locators[0]).toMatchObject({ strategy: 'role', value: 'link "Download ZIP"' });
  expect(fixed.steps[1].timeoutMs).toBe(2000); // only the locators changed

  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  run = await ended(shell);
  expect(run.status, run.error ?? '').toBe('done');
});

test('plan §7 safety: a click that reads like deleting waits for your OK; a site outside the allowlist too', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  const workflow = await teach(app, shell, `${demo.origin}/confirm`, async page => {
    await page.getByRole('button', { name: 'Delete this note' }).click();
    await expect(page.getByRole('status')).toHaveText('Deleted (demo only).');
  });
  await open(app, shell, `${demo.origin}/`);
  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.waitingFor).toBe('confirm');
  expect((await state(shell)).run!.pauseReason).toBe('Needs you: "Click button "Delete this note"" looks like buying, paying or deleting something. Press Resume to allow it for this run, or Stop.');
  // Nothing was clicked while it waits.
  const confirmPage = app.context().pages().find(candidate => candidate.url() === `${demo.origin}/confirm`)!;
  await expect(confirmPage.getByRole('status')).toHaveText('');
  await shell.getByRole('button', { name: '▶ Resume' }).click();
  let run = await ended(shell);
  expect(run.status, run.error ?? '').toBe('done');
  await expect(confirmPage.getByRole('status')).toHaveText('Deleted (demo only).');

  // The allowlist: only example.com is allowed, so the demo site needs your OK (once per run).
  expect((await shell.evaluate(() => window.vestigium.setSafety({ allowlist: ['example.com'], confirmRisky: false }))).ok).toBe(true);
  expect((await shell.evaluate(id => window.vestigium.runWorkflow(id), workflow.id)).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.waitingFor).toBe('site');
  expect((await state(shell)).run!.pauseReason).toBe(`Needs you: This run wants to use ${new URL(demo.origin).host}, which is not on your list of allowed sites. Press Resume to allow it for this run, or Stop.`);
  await shell.getByRole('button', { name: '▶ Resume' }).click();
  run = await ended(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(await logged(shell, 'Needs you: This run wants to use')).toBe(1);
});

test('a link on the clipboard is offered once; minimizing while downloading hides Vestigium to the tray', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  const url = `${demo.origin}/item/3`;
  // The test's stand-in clipboard (see fixtures.ts), never the real one.
  await app.evaluate(({ BrowserWindow }, text) => {
    (globalThis as unknown as { __testClipboard?: string }).__testClipboard = text;
    BrowserWindow.getAllWindows()[0].emit('focus');
  }, url);
  await expect(shell.getByRole('button', { name: `Open copied link ${url}` })).toBeVisible();
  await shell.getByRole('button', { name: `Open copied link ${url}` }).click();
  await expect.poll(async () => (await state(shell)).tabs.some(tab => tab.url === url)).toBe(true);
  expect((await state(shell)).clipboardUrl).toBeNull();
  // The same clipboard text is not offered again.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  expect((await state(shell)).clipboardUrl).toBeNull();

  expect((await shell.evaluate(() => window.vestigium.setTray({ minimizeToTray: true }))).ok).toBe(true);
  const page = await open(app, shell, `${demo.origin}/item/1?variant=large&throttle=400000`);
  await page.getByRole('link', { name: 'Download ZIP / generated file' }).click();
  await expect.poll(async () => (await state(shell)).downloads.counts.running).toBe(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  expect(await logged(shell, 'Vestigium keeps working in the tray.')).toBe(1);
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 30_000 }).toBe(1);
});
