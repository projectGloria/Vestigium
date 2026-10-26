import type { ElectronApplication, Page } from '@playwright/test';
import type { RunSettings, RunState, Workflow } from '../../src/shared/types.js';
import { test, expect, call, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 8 definition of done: "The countdown scenario pauses for me, then continues automatically." Plus the other
// human-in-the-loop cases of plan §4: a captcha (never clicked by Vestigium) and a login that expired mid-run.

const FAST: RunSettings = { stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 };

async function teach(app: ElectronApplication, shell: Page, url: string, actions: (page: Page) => Promise<void>): Promise<Workflow> {
  const page = await open(app, shell, url);
  await shell.evaluate(settings => window.vestigium.setRunSettings(settings), FAST);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await actions(page);
  return stopRecording(shell);
}

async function freshTab(app: ElectronApplication, shell: Page, origin: string) {
  await open(app, shell, `${origin}/`);
  await shell.getByRole('button', { name: 'New tab' }).click();
}

const start = (shell: Page, id: string) => shell.evaluate(workflow => window.vestigium.runWorkflow(workflow), id);
// finishedRun() returns on any status but "running"; these runs pause first, so wait for the end itself.
const done = async (shell: Page, timeout = 30_000) => {
  await expect.poll(async () => (await state(shell)).run?.status, { timeout }).toMatch(/^(done|failed|stopped)$/);
  return (await state(shell)).run!;
};
const waiting = async (shell: Page): Promise<RunState | null> => {
  const run = (await state(shell)).run;
  return run?.status === 'paused' && run.waitingFor ? run : null;
};

test('the countdown pauses the run for you, then it continues by itself once the button is ready', async ({ demo, launch }, info) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await open(app, shell, `${demo.hostOrigin}/countdown`); // the file host's own cookie banner, once
  const workflow = await teach(app, shell, `${demo.origin}/item/1?variant=countdown`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  expect(workflow.steps.map(step => step.onFail)).not.toContain('pause'); // nothing set up by hand

  await freshTab(app, shell, demo.origin);
  expect((await start(shell, workflow.id)).ok).toBe(true);
  // Paused, saying why, with the countdown's own words; the step's page is the visible tab.
  await expect.poll(() => waiting(shell), { timeout: 15_000 }).not.toBeNull();
  const paused = (await waiting(shell))!;
  expect(paused.waitingFor).toBe('countdown');
  expect(paused.pauseReason).toMatch(/^Needs you: The page says "Wait \d seconds?[^"]*"; "Download "field-notes\.zip" by clicking button "Continue"" waits until it is ready\. The run continues by itself once that is done\.$/);
  await expect(shell.getByRole('alert')).toHaveText(paused.pauseReason!);
  const current = await state(shell);
  expect(current.tabs.find(tab => tab.id === current.activeTabId)!.url).toMatch(new RegExp(`^${demo.hostOrigin}/countdown`));
  await shell.screenshot({ path: info.outputPath('needs-you-countdown.png') });

  // Nobody presses Resume: the run continues when the countdown is over and the download starts.
  const run = await done(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(run.results.map(result => result.status)).toEqual(['done', 'done', 'done']);
  expect(await logged(shell, 'Continuing: the page is ready again (countdown).')).toBe(1);
  await expect.poll(async () => (await state(shell)).downloads.counts.done).toBe(1);
});

test('a captcha is never clicked by Vestigium: the run waits until you solve it, then continues', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await open(app, shell, `${demo.hostOrigin}/captcha`); // the file host's own cookie banner, once
  const workflow = await teach(app, shell, `${demo.origin}/item/1?variant=captcha`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await page.getByRole('checkbox', { name: "I'm not a robot" }).click();
    await page.getByRole('link', { name: 'Continue' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  expect(await logged(shell, 'You solved a captcha; it is not recorded.')).toBe(1);
  // Open, Download ZIP, Continue: the captcha click is not a step.
  expect(workflow.steps.map(step => step.label)).toEqual([`Open ${demo.origin}/item/1?variant=captcha`, 'Click link "Download ZIP"', 'Download "field-notes.zip" by clicking link "Continue"']);

  await freshTab(app, shell, demo.origin);
  expect((await start(shell, workflow.id)).ok).toBe(true);
  await expect.poll(() => waiting(shell), { timeout: 15_000 }).not.toBeNull();
  expect((await waiting(shell))!.pauseReason).toBe("Needs you: Solve a captcha (I'm not a robot) in the page. The run continues by itself once that is done.");
  // It stays paused: nothing solves it but you.
  await new Promise(resolve => setTimeout(resolve, 3000));
  expect((await waiting(shell))?.waitingFor).toBe('captcha');

  // The person solves it in the page; the run notices and continues on its own.
  const host = app.context().pages().find(page => page.url().startsWith(`${demo.hostOrigin}/captcha`))!;
  await host.getByRole('checkbox', { name: "I'm not a robot" }).click();
  const run = await done(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(await logged(shell, 'Continuing: the page is ready again (captcha).')).toBe(1);
});

test('a short link whose first button is the captcha: the run never presses it, even after Resume', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  await open(app, shell, `${demo.hostOrigin}/shortlink`); // the file host's own cookie banner, once
  const workflow = await teach(app, shell, `${demo.origin}/item/1?variant=shortlink`, async page => {
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    const host = await popup;
    await host.getByRole('button', { name: 'Get Link' }).click(); // the captcha: not recorded
    await host.waitForURL(/\/shortlink\/go/);
    await expect(host.getByRole('link', { name: 'Get Link' })).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
    await host.getByRole('link', { name: 'Get Link' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  expect(await logged(shell, 'You solved a captcha; it is not recorded.')).toBe(1);
  // The recorded "Get Link" is the countdown page's link; its id and name also match the captcha button.
  expect(workflow.steps.at(-1)!.label).toBe('Download "field-notes.zip" by clicking link "Get Link" (in popup-1)');

  await freshTab(app, shell, demo.origin);
  expect((await start(shell, workflow.id)).ok).toBe(true);
  await expect.poll(() => waiting(shell), { timeout: 15_000 }).not.toBeNull();
  expect((await waiting(shell))!.waitingFor).toBe('captcha');
  const host = app.context().pages().find(page => page.url().startsWith(`${demo.hostOrigin}/shortlink`))!;

  // What happened in the real run: the person presses Resume while the captcha button is still there. The run
  // tries the step again, refuses the captcha button and waits for the person again; the page has not moved.
  expect((await shell.evaluate(() => window.vestigium.resumeRun())).ok).toBe(true);
  await expect.poll(() => logged(shell, 'Needs you: Solve a captcha'), { timeout: 15_000 }).toBe(2);
  expect(host.url()).toMatch(/\/shortlink\?/);

  // The person presses the captcha button; the run waits out the countdown and downloads by itself.
  await host.getByRole('button', { name: 'Get Link' }).click();
  const run = await done(shell, 60_000);
  expect(run.status, run.error ?? '').toBe('done');
  await expect.poll(() => logged(shell, 'Download started: field-notes.zip'), { timeout: 15_000 }).toBe(1);
});

test('a login that expired before the run: it waits for you to sign in, then continues and downloads', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  const { app, shell } = await launch();
  const signIn = async (page: Page) => {
    await page.getByLabel('Username').fill('demo');
    await page.getByLabel('Password').fill('vestigium');
    await page.getByRole('button', { name: 'Sign in' }).click();
  };
  // Signed in before teaching, so the workflow is just "open the item, download".
  const entry = await open(app, shell, `${demo.origin}/login?returnTo=${encodeURIComponent('/item/2?login=1')}`);
  await signIn(entry);
  await expect(entry).toHaveURL(`${demo.origin}/item/2?login=1`);
  const workflow = await teach(app, shell, `${demo.origin}/item/2?login=1`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  expect(workflow.steps.map(step => step.type)).toEqual(['navigate', 'download']);

  // The session ends (as if it expired): opening the item now lands on the login form.
  await app.evaluate(({ session }) => session.fromPartition('persist:vestigium').clearStorageData({ storages: ['cookies'] }));
  await freshTab(app, shell, demo.origin);
  expect((await start(shell, workflow.id)).ok).toBe(true);
  await expect.poll(() => waiting(shell), { timeout: 20_000 }).not.toBeNull();
  const paused = (await waiting(shell))!;
  expect(paused.waitingFor).toBe('login');
  expect(paused.pauseReason).toBe('Needs you: The site wants you to sign in. Sign in in the page. The run continues by itself once that is done.');

  // The person signs in where the run waits; the site returns to the item page and the run continues by itself.
  const wall = app.context().pages().find(candidate => /\/login\?returnTo=/.test(candidate.url()))!;
  await signIn(wall);
  const run = await done(shell);
  expect(run.status, run.error ?? '').toBe('done');
  expect(await logged(shell, 'Continuing: the page is ready again (login).')).toBe(1);
  // The queue downloads with the new session's cookies.
  await expect.poll(async () => (await state(shell)).downloads.counts.done).toBe(1);
});

test('closing the app during a run saves that run to the history before the database closes', async ({ demo, launch }) => {
  test.setTimeout(120_000);
  let { app, shell } = await launch();
  await open(app, shell, `${demo.hostOrigin}/captcha`); // the file host's own cookie banner, once
  const workflow = await teach(app, shell, `${demo.origin}/item/1?variant=captcha`, async page => {
    await page.getByRole('link', { name: 'Download ZIP' }).click();
    await page.getByRole('checkbox', { name: "I'm not a robot" }).click();
    await page.getByRole('link', { name: 'Continue' }).click();
    await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  });
  await freshTab(app, shell, demo.origin);
  expect((await start(shell, workflow.id)).ok).toBe(true);
  await expect.poll(() => waiting(shell), { timeout: 15_000 }).not.toBeNull();
  await app.close();

  ({ app, shell } = await launch());
  const current = await state(shell);
  expect(current.history.map(run => [run.workflowId, run.status])).toEqual([[workflow.id, 'stopped']]);
  expect(current.logs.some(entry => entry.message.startsWith('The run could not be saved to the history'))).toBe(false);
});
