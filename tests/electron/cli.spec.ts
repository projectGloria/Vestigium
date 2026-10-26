import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import type { Step } from '../../src/shared/types.js';
import { test, expect, call, logged, open, state, stopRecording } from './fixtures.js';

// Milestone 9 definition of done, first half: "CLI run produces the same result as the GUI run." The same profile is
// run twice on the same list: from the window (▶ Start) and from `vestigium run`, each into its own folder; the
// files must be the same, byte for byte, and the sidecars the same apart from their "Saved:" time.

type LoopPages = Extract<Step, { type: 'loop_pages' }>;

interface Finished { code: number | null; stdout: string; stderr: string }

// The real binary as a child process, like a user's terminal: same app, same profile, no window.
function cli(profile: string, args: string[]): Promise<Finished> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.VESTIGIUM_USER_DATA = profile;
  env.VESTIGIUM_TEST = '1';
  env.VESTIGIUM_DOWNLOADS = join(profile, 'downloads');
  return new Promise((done, failed) => {
    // "--" first, as vestigium.cmd and npm run cli do: Electron refuses to start when any argument follows a URL-like
    // one (--url http://…) unless "--" comes before them (its CVE-2018-1000006 guard).
    const child = spawn(electronPath as unknown as string, [resolve('out/main/app.cjs'), '--', ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    child.on('error', failed);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

async function files(folder: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    // Sidecars record when they were written and where they were unpacked (each run has its own folder);
    // everything else in them must match.
    const comparable = entry.name.endsWith('_info.txt')
      ? Buffer.from(bytes.toString('utf8').replace(/^Saved: .*$/m, 'Saved: (time)').replaceAll(folder, '(folder)'))
      : bytes;
    result[path.slice(folder.length + 1)] = createHash('sha256').update(comparable).digest('hex');
  }
  return result;
}

test('vestigium run produces the same files as ▶ Start in the window', async ({ demo, launch, profile }) => {
  test.setTimeout(240_000);
  const host = new URL(demo.origin).host;
  let { app, shell } = await launch();
  // Teach once (the site profile), with a template so both runs place files the same way.
  const page = await open(app, shell, `${demo.origin}/list?variant=aes`);
  expect((await call(shell, 'recordStart')).ok).toBe(true);
  await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => logged(shell, 'Download requested')).toBe(1);
  const workflow = await stopRecording(shell);
  const pages = workflow.steps[1] as LoopPages;
  let current = (await state(shell)).selectedWorkflow!;
  for (const change of [{ kind: 'set-max-pages', stepId: pages.id, maxPages: 1 }, { kind: 'set-max-items', stepId: pages.params.steps[0].id, maxItems: 4 }]) {
    const result = await shell.evaluate(([id, at, what]) => window.vestigium.updateWorkflow(id as string, at as number, what as never), [current.id, current.version, change] as const);
    if (!result.ok) throw new Error(result.error);
    current = result.state.selectedWorkflow!;
  }
  await shell.evaluate(() => window.vestigium.setRunSettings({ stepDelayMinMs: 0, stepDelayMaxMs: 0, hostIntervalMs: 0 }));
  await shell.evaluate(() => window.vestigium.setDownloadOptions({ concurrency: 3, retries: 2, force: true, template: '{site}/{tag}/{title}.{ext}', sidecar: true, extract: 'keep' }));

  // GUI: ▶ Start on the list.
  const list = `${demo.origin}/list?variant=aes`;
  await open(app, shell, list);
  await shell.getByRole('banner').getByRole('button', { name: '▶ Start', exact: true }).click();
  await expect.poll(async () => (await state(shell)).run?.status, { timeout: 60_000 }).toBe('done');
  await expect.poll(async () => (await state(shell)).downloads.counts.done, { timeout: 60_000 }).toBe(4);
  // One process per profile: the window must be closed for the command line to use it.
  await app.close();

  // CLI: the same profile on the same list, into another folder; Force so the same items download again.
  const output = join(profile, 'cli-output');
  const help = await cli(profile, ['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('vestigium run --profile <site>');
  const wrong = await cli(profile, ['run']);
  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toContain('run needs --profile <site>.');
  const listed = await cli(profile, ['profiles']);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain(`${host}\tok\t`);

  const run = await cli(profile, ['run', '--profile', host, '--url', list, '--output', output, '--max-pages', '1', '--max-items', '4', '--force']);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(run.stdout).toContain(`Running the ${host} profile on ${list}.`);
  expect(run.stdout).toContain('Run done.');
  expect(run.stdout).toContain('  Opened 4 items; stopped at the limit of 4 items.');
  expect(run.stdout).toContain('Downloads: 4 done, 0 failed.');

  // Files go under the site's host name (no port): {site} in the default template.
  const site = new URL(demo.origin).hostname;
  const gui = await files(join(profile, 'downloads', site));
  const fromCli = await files(join(output, site));
  expect(Object.keys(gui).length).toBeGreaterThan(8); // 4 archives, their sidecars, and the unpacked files
  expect(fromCli).toEqual(gui);

  // An unknown site is refused with the saved ones listed; the window is never needed for that.
  const unknown = await cli(profile, ['run', '--profile', 'nowhere.test']);
  expect(unknown.code).toBe(3);
  expect(unknown.stdout).toContain(`No site profile for nowhere.test. Saved profiles: ${host}.`);

  // The window comes back as before, with the CLI's run in its history.
  ({ app, shell } = await launch());
  expect((await state(shell)).history.slice(0, 2).map(record => record.status)).toEqual(['done', 'done']);
});
