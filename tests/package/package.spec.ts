import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect, _electron as electron } from '@playwright/test';
import { createDemoServer, type DemoServer } from '../demo-site/server.js';
import type { Result } from '../../src/shared/ipc.js';
import type { AppState } from '../../src/shared/types.js';

// Milestone 9, second half: the installer. Run after `npm run dist` with `npm run test:package`.
// The app is taken *out of the installer* (its payload, $PLUGINSDIR\app-64.7z, extracted with 7-Zip) into a
// temporary folder, so these tests launch exactly the files a user's install gets, without installing anything into
// this machine's user account (no shortcuts, no registry entries). A truly clean machine is a manual check
// (docs/MILESTONE-9-VERIFICATION.md).

const SETUP = readdirSync('release').find(name => /^Vestigium Setup .+\.exe$/.test(name));
const SEVEN_ZIP = [process.env.ProgramFiles && join(process.env.ProgramFiles, '7-Zip', '7z.exe')].find(path => path && existsSync(path));

let installed = '';
const test = base.extend<{ demo: DemoServer; profile: string }>({
  demo: async ({}, use, info) => {
    const demo = await createDemoServer({ port: 0, hostPort: 0, logDirectory: info.outputPath('demo-logs') });
    await use(demo);
    await demo.close();
  },
  profile: async ({}, use) => use(mkdtempSync(join(tmpdir(), 'vestigium-package-profile-'))),
});

test.beforeAll(() => {
  expect(SETUP, 'Build the installer first: npm run dist').toBeTruthy();
  if (!SEVEN_ZIP) {
    // Without 7-Zip the payload cannot be opened; the identical packaged folder is used instead.
    installed = resolve('release/win-unpacked');
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'vestigium-package-'));
  execFileSync(SEVEN_ZIP, ['e', join('release', SETUP!), `-o${work}`, '$PLUGINSDIR/app-64.7z', '-y'], { stdio: 'ignore' });
  installed = join(work, 'app');
  execFileSync(SEVEN_ZIP, ['x', join(work, 'app-64.7z'), `-o${installed}`, '-y'], { stdio: 'ignore' });
});

const env = (profile: string) => {
  const result = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete result.ELECTRON_RUN_AS_NODE;
  return { ...result, VESTIGIUM_USER_DATA: profile, VESTIGIUM_DOWNLOADS: join(profile, 'downloads'), VESTIGIUM_TEST: '1', VESTIGIUM_FILTER_REFRESH: 'off' };
};

test('the app from the installer starts, opens its window, browses and keeps its database', async ({ demo, profile }) => {
  test.setTimeout(120_000);
  const executable = join(installed, 'Vestigium.exe');
  expect(existsSync(executable)).toBe(true);
  expect(existsSync(join(installed, 'vestigium.cmd'))).toBe(true);
  const app = await electron.launch({ executablePath: executable, env: env(profile), timeout: 30_000 });
  try {
    const shell = await app.firstWindow();
    await expect(shell.getByRole('button', { name: 'Go', exact: true })).toBeVisible();
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    await shell.getByRole('textbox', { name: 'URL' }).fill(`${demo.origin}/list`);
    await shell.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(async () => {
      const result = await shell.evaluate(() => window.vestigium.getState()) as Result;
      return result.ok ? (result.state as AppState).tabs.some(tab => tab.title.startsWith('The field notes collection')) : false;
    }).toBe(true);
    // The filter lists ship in resources\filter-lists (extraResources) and the ad blocker loaded them.
    expect(existsSync(join(installed, 'resources', 'filter-lists', 'manifest.json'))).toBe(true);
    const result = await shell.evaluate(() => window.vestigium.getState()) as Result;
    expect(result.ok && (result.state as AppState).adblock.filters).toBeGreaterThan(50_000);
  } finally {
    await app.close();
  }
  // SQLite opened (the native module loaded from app.asar.unpacked) and the log says so.
  expect(readdirSync(profile)).toEqual(expect.arrayContaining(['vestigium.sqlite', 'logs']));
});

test('vestigium.cmd from the installer runs the command line', async ({ profile }) => {
  const shim = join(installed, 'vestigium.cmd');
  const run = (args: string[]) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" ${args.join(' ')}`], { env: env(profile), encoding: 'utf8', windowsVerbatimArguments: true });
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('vestigium run --profile <site>');
  const profiles = run(['profiles']);
  expect(profiles.status).toBe(0);
  expect(profiles.stdout).toContain('No site profiles yet.');
  // A URL followed by more options: the shim's "--" gets it past Electron's command-line guard.
  const unknown = run(['run', '--profile', 'nowhere.test', '--url', 'http://127.0.0.1:9/list?x=1', '--max-pages', '1']);
  expect(unknown.status).toBe(3);
  expect(unknown.stdout).toContain('No site profile for nowhere.test.');
});
