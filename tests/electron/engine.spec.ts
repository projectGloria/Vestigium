import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DemoServer } from '../demo-site/server.js';
import type { Result } from '../../src/shared/ipc.js';
import type { RunMode, RunSettings, Workflow } from '../../src/shared/types.js';
import { test, expect, call, finishedRun, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 3: self-healing, smart waits, trusted input, run modes, pauses, pacing.

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };

const setPacing = (shell: Page, settings: RunSettings) =>
  shell.evaluate(value => window.vestigium.setRunSettings(value), settings) as Promise<Result>;
const runAs = (shell: Page, id: string, mode: RunMode = 'run') =>
  shell.evaluate(([workflow, how]) => window.vestigium.runWorkflow(workflow, how as RunMode), [id, mode] as const) as Promise<Result>;
const bridgeCall = (shell: Page, name: 'pauseRun' | 'resumeRun' | 'nextStep') =>
  shell.evaluate(method => window.vestigium[method](), name) as Promise<Result>;

async function record(app: ElectronApplication, shell: Page, url: string, actions: (page: Page) => Promise<void>): Promise<Workflow> {
  const page = await open(app, shell, url);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await actions(page);
  return stopRecording(shell);
}

async function freshTab(app: ElectronApplication, shell: Page, demo: DemoServer) {
  await open(app, shell, `${demo.origin}/`);
  await shell.getByRole('button', { name: 'New tab' }).click();
  await expect.poll(async () => {
    const current = await state(shell);
    return current.tabs.find(tab => tab.id === current.activeTabId)?.url;
  }).toBe('about:blank');
}

// Simulates "the site changed after I recorded": edit the workflow JSON, import it through the (stubbed) dialog.
async function importVariant(app: ElectronApplication, shell: Page, workflow: Workflow, path: string, edit: (copy: Workflow) => void) {
  const copy = structuredClone(workflow);
  edit(copy);
  await writeFile(path, JSON.stringify(copy, null, 2));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
  const result = await shell.evaluate(() => window.vestigium.importWorkflow());
  if (!result.ok) throw new Error(result.error);
  return result.state.selectedWorkflow!;
}

const recordDownload = (app: ElectronApplication, shell: Page, url: string) => record(app, shell, url, async page => {
  await page.getByRole('link', { name: /^Download ZIP/ }).click();
  await expect.poll(async () => (await state(shell)).logs.some(entry => entry.message.startsWith('Download requested'))).toBe(true);
});

test('replay survives the random class-rename mode and structural changes (milestone 3 definition of done)', async ({ demo, launch }, info) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await setPacing(shell, FAST);
  // Recorded while classes are randomized; every later render gets new random classes.
  const workflow = await recordDownload(app, shell, `${demo.origin}/item/1?mutate=classes`);
  for (let round = 1; round <= 3; round++) {
    await freshTab(app, shell, demo);
    expect((await runAs(shell, workflow.id)).ok).toBe(true);
    const run = await finishedRun(shell);
    expect(run.status, run.error ?? '').toBe('done');
    expect(run.results.at(-1)!.locator).toBe('role: link "Download ZIP"');
  }
  // The same workflow against a page where the button is also wrapped, moved and the content reordered.
  const changed = await importVariant(app, shell, workflow, info.outputPath('all.json'), copy => {
    (copy.steps[0].params as { url: string }).url = `${demo.origin}/item/1?mutate=all`;
  });
  await freshTab(app, shell, demo);
  expect((await runAs(shell, changed.id)).ok).toBe(true);
  const run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(await logged(shell, 'Download started: field-notes.zip')).toBe(4);
  // The best locator matched every time, so nothing was flagged for review.
  expect((await state(shell)).selectedWorkflow!.steps.some(step => step.review)).toBe(false);
});

test('a renamed button is healed, saved with a review flag, and can be kept or undone in the UI', async ({ demo, launch }, info) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await setPacing(shell, FAST);
  const workflow = await recordDownload(app, shell, `${demo.origin}/item/1`);

  // Variant 1: the label changed but the class did not; the class-based CSS fallback finds it.
  const fallback = await importVariant(app, shell, workflow, info.outputPath('label.json'), copy => {
    (copy.steps[0].params as { url: string }).url = `${demo.origin}/item/1?mutate=label`;
  });
  await freshTab(app, shell, demo);
  expect((await runAs(shell, fallback.id)).ok).toBe(true);
  let run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results[1].locator).toBe('css: a.download-action');
  let saved = (await state(shell)).selectedWorkflow!;
  expect(saved.version).toBe(fallback.version + 1);
  expect(saved.steps[1].review!.reason).toBe('The best recorded locator no longer matched; matched by css instead.');
  expect(saved.steps[1].locators[0]).toEqual({ strategy: 'role', value: 'link "Download ZIP file"', confidence: 0.9 });
  const review = shell.getByRole('note', { name: 'Review step 2' });
  await expect(review).toContainText('⚠ Healed during a run.');
  await expect(shell.getByRole('region', { name: 'Workflow' })).toContainText('1 to review');
  await shell.screenshot({ path: info.outputPath('heal-review.png') });
  await review.getByRole('button', { name: 'Keep new locators' }).click();
  await expect(review).toBeHidden();
  saved = (await state(shell)).selectedWorkflow!;
  expect(saved.steps[1].review).toBeUndefined();
  expect(saved.steps[1].locators[0].value).toBe('link "Download ZIP file"');

  // Variant 2: no CSS locator either; only fuzzy healing on role + name + structure can find the button.
  const fuzzy = await importVariant(app, shell, workflow, info.outputPath('fuzzy.json'), copy => {
    (copy.steps[0].params as { url: string }).url = `${demo.origin}/item/1?mutate=label`;
    copy.steps[1].locators = copy.steps[1].locators.filter(locator => locator.strategy !== 'css');
  });
  await freshTab(app, shell, demo);
  expect((await runAs(shell, fuzzy.id)).ok).toBe(true);
  run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results[1].locator).toBe('healed: link "Download ZIP file"');
  expect(run.results[1].message).toMatch(/^Healed\. No recorded locator matched; healed to link "Download ZIP file" \(recorded as "Download ZIP", \d+% similar\)\.$/);
  expect(await logged(shell, 'Self-healed "Download')).toBe(2);
  await shell.getByRole('note', { name: 'Review step 2' }).getByRole('button', { name: 'Undo heal' }).click();
  await expect(shell.getByRole('note', { name: 'Review step 2' })).toBeHidden();
  expect((await state(shell)).selectedWorkflow!.steps[1].locators).toEqual(fuzzy.steps[1].locators);
});

test('main-frame clicks are trusted OS-level input; a cookie banner that returns is dismissed during replay', async ({ demo, launch }) => {
  const { app, shell } = await launch();
  await setPacing(shell, FAST);
  const workflow = await record(app, shell, `${demo.origin}/lab`, async page => {
    await page.getByRole('button', { name: 'Trusted action' }).click();
    await expect(page.locator('#trusted-status')).toHaveText('Trusted click received');
  });
  await freshTab(app, shell, demo);
  // Bring the banner back for this origin (as on a fresh profile or after the site resets consent).
  const other = app.context().pages().find(page => page.url() === `${demo.origin}/`)!;
  await other.evaluate(() => localStorage.removeItem('cookies'));
  expect((await runAs(shell, workflow.id)).ok).toBe(true);
  const run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  const replayed = app.context().pages().find(page => page.url() === `${demo.origin}/lab`)!;
  await expect(replayed.locator('#trusted-status')).toHaveText('Trusted click received');
  await expect(replayed.getByRole('dialog', { name: 'Cookie preferences' })).toBeHidden();
  expect(await logged(shell, 'Dismissed a cookie banner ("Accept cookies") before "Click button "Trusted action""')).toBe(1);
});

test('dry run highlights targets without acting; step mode pauses before each step; pause and resume work', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await setPacing(shell, FAST);
  // Two Next clicks: pagination links are not list items, so this recording stays a flat three-step workflow
  // (an item click would be generalized into loops since milestone 5; those run modes are in items.spec.ts).
  const workflow = await record(app, shell, `${demo.origin}/list`, async page => {
    await page.getByRole('link', { name: 'Next →' }).click();
    await expect(page).toHaveURL(`${demo.origin}/list?page=2`);
    await page.getByRole('link', { name: 'Next →' }).click();
    await expect(page).toHaveURL(`${demo.origin}/list?page=3`);
  });
  expect(workflow.steps.map(step => step.type)).toEqual(['navigate', 'click', 'click']);

  // Dry run: the list is opened (navigation is harmless), the first Next link is found but not clicked,
  // and the second cannot be checked because its page was never reached.
  await freshTab(app, shell, demo);
  expect((await runAs(shell, workflow.id, 'dry')).ok).toBe(true);
  let run = await finishedRun(shell);
  expect(run).toMatchObject({ status: 'done', mode: 'dry' });
  expect(run.results.map(result => [result.status, result.message])).toEqual([
    ['done', 'Done.'],
    ['done', 'Found and highlighted; not acted on (dry run).'],
    ['skipped', 'Not checked in a dry run: an earlier step would have changed this page.'],
  ]);
  await expect.poll(async () => {
    const current = await state(shell);
    return current.tabs.find(tab => tab.id === current.activeTabId)?.url;
  }).toBe(`${demo.origin}/list`);

  // Step mode: paused before step 1; Next runs exactly one step; Resume finishes normally.
  await freshTab(app, shell, demo);
  expect((await runAs(shell, workflow.id, 'step')).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.pauseReason).toBe(`Next: step 1/3: Open ${demo.origin}/list`);
  await expect(shell.getByRole('status')).toHaveText(`Next: step 1/3: Open ${demo.origin}/list`);
  await shell.getByRole('button', { name: '⏭ Next step' }).click();
  await expect.poll(async () => (await state(shell)).run?.pauseReason).toBe('Next: step 2/3: Click link "Next →"');
  expect((await state(shell)).run!.results.map(result => result.status)).toEqual(['done']);
  await shell.getByRole('button', { name: '▶ Resume' }).click();
  run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results).toHaveLength(3);

  // Pause mid-run (slow pacing so there is time), then resume.
  await setPacing(shell, { stepDelayMinMs: 1500, stepDelayMaxMs: 1500, hostIntervalMs: 0 });
  await freshTab(app, shell, demo);
  expect((await runAs(shell, workflow.id)).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.results.length).toBe(1);
  await shell.getByRole('button', { name: '❚❚ Pause' }).click();
  await expect.poll(async () => (await state(shell)).run?.status).toBe('paused');
  expect((await state(shell)).run!.pauseReason).toMatch(/^Paused by you before step [23]\/3: /);
  expect(await bridgeCall(shell, 'pauseRun')).toEqual({ ok: false, error: 'The run is not running.' });
  expect((await bridgeCall(shell, 'resumeRun')).ok).toBe(true);
  run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
});

test('a step set to "pause" waits for the user, then retries on Resume (countdown)', async ({ demo, launch }, info) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await setPacing(shell, FAST);
  await open(app, shell, `${demo.hostOrigin}/countdown`); // dismiss the file host's own cookie banner first
  const workflow = await record(app, shell, `${demo.origin}/item/1?variant=countdown`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(async () => (await state(shell)).logs.some(entry => entry.message.startsWith('Download requested'))).toBe(true);
  });
  // The Continue step gives up after one second and asks the user instead of failing.
  const patient = await importVariant(app, shell, workflow, info.outputPath('pause.json'), copy => {
    copy.steps[2].onFail = 'pause';
    copy.steps[2].timeoutMs = 1000;
  });
  await freshTab(app, shell, demo);
  expect((await runAs(shell, patient.id)).ok).toBe(true);
  await expect.poll(async () => (await state(shell)).run?.status).toBe('paused');
  const reason = (await state(shell)).run!.pauseReason!;
  expect(reason).toMatch(/^Step 3\/3 needs you: .*is disabled\. Waited 1 s\. Fix it in the page, then press Resume to retry this step\.$/);
  await expect(shell.getByRole('alert')).toHaveText(reason);
  // The countdown finishes on its own; the user presses Resume and the step is retried.
  const host = app.context().pages().find(page => page.url().startsWith(`${demo.hostOrigin}/countdown`))!;
  await expect(host.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 10_000 });
  await shell.getByRole('button', { name: '▶ Resume' }).click();
  const run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results.map(result => result.status)).toEqual(['done', 'done', 'done']);
});

test('pacing: a per-host interval spaces out steps and is persisted as a setting', async ({ demo, launch }) => {
  test.setTimeout(90_000);
  const { app, shell } = await launch();
  const invalid = await setPacing(shell, { stepDelayMinMs: 500, stepDelayMaxMs: 100, hostIntervalMs: 0 });
  expect(invalid.ok).toBe(false);
  expect((await setPacing(shell, { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 1200 })).ok).toBe(true);
  expect((await state(shell)).settings.run).toEqual({ stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 1200 });
  const workflow = await record(app, shell, `${demo.origin}/lab`, async page => {
    await page.getByRole('button', { name: 'Shadow action' }).click();
    await page.getByRole('button', { name: 'Trusted action' }).click();
  });
  expect(workflow.steps).toHaveLength(3);
  await freshTab(app, shell, demo);
  const started = Date.now();
  expect((await runAs(shell, workflow.id)).ok).toBe(true);
  const run = await finishedRun(shell);
  expect(run.status, run.error ?? '').toBe('done');
  // Three steps on one host: at least two full intervals between them.
  expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
});
