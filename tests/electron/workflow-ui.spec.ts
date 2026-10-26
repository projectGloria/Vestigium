import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, finishedRun, open, state } from './fixtures.js';

// Milestone 2 through the UI only: Teach → Stop → inspect/edit steps → Run → History, plus export/import/delete.

const workflowPanel = (shell: Page) => shell.getByRole('region', { name: 'Workflow' });
// Top-level rows only; loop bodies are nested lists inside them.
const steps = (shell: Page) => workflowPanel(shell).getByRole('list', { name: 'Steps', exact: true }).locator(':scope > li');
const step = (shell: Page, number: string) => workflowPanel(shell).getByRole('listitem', { name: `Step ${number}`, exact: true });

test('teach, edit, run and inspect a workflow entirely from the UI', async ({ demo, launch }, info) => {
  test.setTimeout(90_000);
  const { app, shell } = await launch();
  await expect(workflowPanel(shell)).toContainText('No workflow selected');
  await expect(shell.getByRole('button', { name: '▶ Run' })).toBeDisabled();

  // Teach.
  const page = await open(app, shell, `${demo.origin}/list`);
  await shell.getByRole('button', { name: '● Teach' }).click();
  await expect(shell.getByRole('status')).toHaveText(/^Recording · \d+ events$/);
  await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await expect(page).toHaveURL(`${demo.origin}/item/1`);
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect(shell.getByRole('button', { name: /^■ Stop recording · \d+$/ })).toBeVisible();
  await expect.poll(async () => (await state(shell)).logs.some(entry => entry.message.startsWith('Download requested'))).toBe(true);
  await shell.getByRole('button', { name: /^■ Stop recording/ }).click();

  // The plain-language steps are shown, with their locators one click away. Since milestone 5 the opened item is
  // generalized: step 2 repeats on every page, 2.1 for every item, and 2.1.1 is the download on each item page.
  await expect(steps(shell)).toHaveCount(2);
  await expect(step(shell, '2')).toContainText('Repeat on every page');
  await expect(step(shell, '2.1')).toContainText('Repeat for every item');
  await expect(step(shell, '2.1.1')).toContainText('Download "field-notes.zip" by clicking link "Download ZIP"');
  await step(shell, '2.1.1').getByText(/^Locators \(\d+\)$/).click();
  const locators = step(shell, '2.1.1').getByRole('table', { name: 'Locators' });
  await expect(locators.getByRole('row').nth(1)).toContainText('role');
  await expect(locators.getByRole('row').nth(1)).toContainText('link "Download ZIP"');
  await expect(workflowPanel(shell).getByRole('textbox', { name: 'Workflow name' })).toHaveValue(/^Recording · 127\.0\.0\.1:\d+ · /);

  // Rename the workflow and a step; disable, then re-enable a step; reorder is refused where it makes no sense.
  const name = workflowPanel(shell).getByRole('textbox', { name: 'Workflow name' });
  await name.fill('Field notes download');
  await name.press('Enter');
  await expect(workflowPanel(shell).getByRole('navigation', { name: 'Saved workflows' })).toContainText('Field notes download');
  await step(shell, '2.1.1').getByRole('button', { name: 'Rename step 2.1.1' }).click();
  const label = step(shell, '2.1.1').getByRole('textbox', { name: 'Label of step 2.1.1' });
  await label.fill('Download the field note');
  await label.press('Enter');
  await expect(step(shell, '2.1.1')).toContainText('Download the field note');
  await step(shell, '2.1.1').getByRole('checkbox', { name: 'Enable step 2.1.1' }).uncheck();
  await expect(step(shell, '2.1.1')).toHaveClass(/disabled/);
  await step(shell, '2.1.1').getByRole('checkbox', { name: 'Enable step 2.1.1' }).check();
  await expect(step(shell, '1').getByRole('button', { name: 'Move step 1 up' })).toBeDisabled();
  // Revision 2 is the link to the site profile learned at Stop recording (milestone 8).
  await expect(workflowPanel(shell)).toContainText('2 steps · revision 6');
  // Keep the run short: one page, two items.
  for (const [field, value] of [['Maximum pages for step 2', '1'], ['Maximum items for step 2.1', '2']]) {
    await workflowPanel(shell).getByRole('spinbutton', { name: field }).fill(value);
    await workflowPanel(shell).getByRole('spinbutton', { name: field }).press('Enter');
  }
  await expect(workflowPanel(shell)).toContainText('2 steps · revision 8');

  // Run from a fresh tab with the toolbar button; results appear on the steps and in History.
  await open(app, shell, `${demo.origin}/`);
  await shell.getByRole('button', { name: 'New tab' }).click();
  await shell.getByRole('button', { name: '▶ Run' }).click();
  const run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  for (const number of ['1', '2', '2.1', '2.1.1']) await expect(step(shell, number).getByLabel('done').first()).toBeVisible();
  await expect(step(shell, '2.1')).toContainText('Opened 2 items; stopped at the limit of 2 items.');
  await expect(step(shell, '2.1.1').locator('tr.used')).toContainText('role');
  await shell.getByRole('tab', { name: 'History' }).click();
  const history = shell.getByRole('tabpanel', { name: 'History' });
  await expect(history).toContainText('Field notes download · done');
  await expect(history).toContainText('Page 1 › Item 2/10 › Download the field note · matched role: link "Download ZIP"');
  await shell.screenshot({ path: info.outputPath('workflow-panel.png') });
});

test('export and import go through native dialogs; delete needs confirmation; stale edits are refused', async ({ demo, launch }, info) => {
  const { app, shell } = await launch();
  const page = await open(app, shell, `${demo.origin}/lab`);
  await shell.getByRole('button', { name: '● Teach' }).click();
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await shell.getByRole('button', { name: /^■ Stop recording/ }).click();
  await expect(steps(shell)).toHaveCount(2);
  const original = (await state(shell)).selectedWorkflow!;

  // Native dialogs cannot be driven by Playwright; stub them in the main process.
  const exportPath = info.outputPath('exported.json');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, exportPath);
  await workflowPanel(shell).getByRole('button', { name: 'Export…' }).click();
  await expect.poll(async () => (await readFile(exportPath, 'utf8').catch(() => '')).length).toBeGreaterThan(0);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  expect(exported).toEqual(original);
  expect(await readFile(exportPath, 'utf8')).toMatch(/^\{\n  "schemaVersion": 1,\n  "id": /);

  await workflowPanel(shell).getByRole('button', { name: 'Import…' }).click();
  await expect.poll(async () => (await state(shell)).workflows.length).toBe(2);
  const imported = (await state(shell)).selectedWorkflow!;
  expect(imported.id).not.toBe(original.id);
  expect(imported.steps).toEqual(original.steps);

  // A cancelled dialog changes nothing.
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  });
  await workflowPanel(shell).getByRole('button', { name: 'Import…' }).click();
  await expect(shell.getByRole('status')).toHaveText('Ready');
  expect((await state(shell)).workflows.length).toBe(2);

  // An edit against an old revision is refused (e.g. two quick edits racing): rename once, then reuse the old revision.
  const name = workflowPanel(shell).getByRole('textbox', { name: 'Workflow name' });
  await name.fill('Imported copy');
  await name.press('Enter');
  await expect.poll(async () => (await state(shell)).selectedWorkflow?.version).toBe(imported.version + 1);
  const stale = await shell.evaluate(([id, version]) => window.vestigium.updateWorkflow(id as string, version as number, { kind: 'rename', name: 'x' }),
    [imported.id, imported.version] as const);
  expect(stale).toEqual({ ok: false, error: 'This workflow changed since it was displayed. Try the edit again.' });
  await expect(shell.getByRole('status')).toHaveText('Ready');

  // Delete takes two clicks; Cancel backs out.
  await workflowPanel(shell).getByRole('button', { name: 'Delete…' }).click();
  await workflowPanel(shell).getByRole('button', { name: 'Cancel' }).click();
  expect((await state(shell)).workflows.length).toBe(2);
  await workflowPanel(shell).getByRole('button', { name: 'Delete…' }).click();
  await workflowPanel(shell).getByRole('button', { name: 'Confirm delete' }).click();
  await expect.poll(async () => (await state(shell)).workflows.map(summary => summary.id)).toEqual([original.id]);
  await expect(workflowPanel(shell)).toContainText('No workflow selected');
  await workflowPanel(shell).getByRole('navigation', { name: 'Saved workflows' }).getByRole('button').click();
  await expect(steps(shell)).toHaveCount(2);
});
