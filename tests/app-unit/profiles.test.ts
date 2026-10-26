import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { openDatabase } from '../../src/main/store/db.js';
import { repositories } from '../../src/main/store/repositories.js';
import { Logger } from '../../src/main/logger.js';
import { SiteProfiles } from '../../src/main/engine/site-profiles.js';
import { RunHistory } from '../../src/main/engine/run-history.js';
import { generalize } from '../../src/main/learn/generalize.js';
import { trayIconPng } from '../../src/main/tray-icon.js';
import { safetySettingsSchema } from '../../src/main/validation.js';
import type { RunState, Step, Workflow } from '../../src/shared/types.js';
import type { ListContext } from '../../src/shared/learn.js';

// Milestone 8: site profiles learned from a generalized recording, Start on a new URL, health grading, run history.

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-'));
  const db = openDatabase(join(directory, 'store.sqlite'));
  const repo = repositories(db);
  const log = new Logger(join(directory, 'logs'));
  return {
    db, repo, log, profiles: new SiteProfiles(repo.siteProfiles, log), history: new RunHistory(repo.runLog, db),
    close() {
      db.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) throw new Error('Refusing cleanup outside the temporary directory.');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const target = (tab = 'main') => ({ tab, frames: [], shadowHosts: [] });
const base = { enabled: true, waitFor: null, timeoutMs: 15000, onFail: 'retry' as const };
const LIST = 'http://shop.test:8080/list';

// What a one-item recording on a paginated list compiles to, before generalization.
function recorded(): { steps: Step[]; lists: Record<string, ListContext> } {
  const steps: Step[] = [
    { ...base, id: 's1', type: 'navigate', label: `Open ${LIST}`, locators: [], params: { url: LIST }, target: target() },
    { ...base, id: 's2', type: 'click', label: 'Click link "Item 3"', locators: [{ strategy: 'role', value: 'link "Item 3"', confidence: 0.9 }], params: {}, target: target(), waitFor: { navigation: true } },
    { ...base, id: 's3', type: 'download', label: 'Download "a.zip" by clicking link "Download"', locators: [{ strategy: 'role', value: 'link "Download"', confidence: 0.9 }],
      params: { filename: 'a.zip', mimeType: 'application/zip' }, target: target(), waitFor: { download: true } },
  ];
  const report = { url: LIST, next: { capture: { locators: [{ strategy: 'role' as const, value: 'link "Next"', confidence: 0.9 }], frames: [], shadowHosts: [], description: 'link "Next"' } as never, disabled: false, evidence: ['rel=next'] },
    loadMore: null, numbered: { current: 1, pages: [] }, contentLinks: 10, scrollable: false };
  return { steps, lists: { s2: { url: LIST, items: { pattern: { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'cards' }, count: 10, index: 2 }, pagination: report } } };
}

function learned(): Workflow {
  const { steps, lists } = recorded();
  return { schemaVersion: 1, id: 'wf', name: 'Shop', siteProfileId: null, steps: generalize(steps, lists).steps, variables: {}, createdAt: '2026-10-23T00:00:00.000Z', version: 1 };
}

const runOf = (overrides: Partial<RunState>): RunState => ({
  workflowId: 'wf', workflowName: 'Shop', mode: 'run', status: 'done', current: null, total: 2, results: [], error: null,
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), pauseReason: null, progress: null, waitingFor: null, failure: null, ...overrides,
});

test('a generalized recording becomes its site\'s profile; Start runs it on another list of that site', () => {
  const f = fixture();
  try {
    const workflow = learned();
    f.repo.workflows.save(workflow);
    assert.equal(f.profiles.learn({ ...workflow, steps: workflow.steps.slice(0, 1) }, 500), null); // no item loop, no profile
    const profile = f.profiles.learn(workflow, 500)!;
    assert.equal(profile.domain, 'shop.test:8080');
    assert.deepEqual(profile.listPattern, { listUrl: LIST });
    assert.deepEqual(profile.itemPattern, { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'cards' });
    assert.equal(profile.rateLimit, 500);
    assert.equal(f.profiles.forHost('shop.test:8080')!.id, profile.id);

    const other = 'http://shop.test:8080/list?category=maps';
    const plan = f.profiles.plan(other, id => f.repo.workflows.get(id)!);
    assert.equal(plan.workflow.steps[0].type === 'navigate' && plan.workflow.steps[0].params.url, other);
    const loop = JSON.stringify(plan.workflow.steps);
    assert.ok(loop.includes(`"listUrl":"${other}"`));
    // The stored workflow is untouched; Start runs a copy.
    assert.equal(f.repo.workflows.get('wf')!.steps[0].type === 'navigate' && (f.repo.workflows.get('wf')!.steps[0].params as { url: string }).url, LIST);
    assert.throws(() => f.profiles.plan('http://elsewhere.test/list', () => workflow), /No site profile for elsewhere\.test yet\. Teach it once/);

    // Teaching the same site again replaces its profile (same id, new workflow).
    const again = f.profiles.learn({ ...workflow, id: 'wf2' }, 900)!;
    assert.equal(again.id, profile.id);
    assert.equal(f.profiles.list().length, 1);
    assert.equal(f.profiles.summaries([{ id: 'wf2', name: 'Shop v2' }])[0].workflowName, 'Shop v2');
  } finally {
    f.close();
  }
});

test('runs grade the profile: ok, degraded (heals or failed items), broken (with the step to re-teach)', () => {
  const f = fixture();
  try {
    f.profiles.learn(learned(), 0);
    const health = () => f.profiles.summaries([])[0];
    f.profiles.grade('wf', runOf({ results: [{ stepId: 's3', label: 'x', status: 'done', message: 'Done.', locator: null }] }));
    assert.equal(health().health, 'ok');
    assert.ok(health().lastVerifiedAt);
    f.profiles.grade('wf', runOf({ results: [{ stepId: 's3', label: 'x', status: 'done', message: 'Healed. The button was renamed.', locator: null }] }));
    assert.equal(health().health, 'degraded');
    f.profiles.grade('wf', runOf({ status: 'failed', failure: { stepId: 's3', label: 'Download "a.zip" by clicking link "Download"', url: 'http://shop.test:8080/item/3' } }));
    assert.equal(health().health, 'broken');
    assert.equal(health().brokenStepId, 's3');
    assert.equal(health().brokenStepLabel, 'Download "a.zip" by clicking link "Download"');
    // A stopped run or a dry run says nothing about the profile.
    f.profiles.grade('wf', runOf({ status: 'stopped' }));
    f.profiles.grade('wf', runOf({ mode: 'dry' }));
    assert.equal(health().health, 'broken');
    f.profiles.grade('wf', runOf({}));
    assert.equal(health().health, 'ok');
    assert.equal(health().brokenStepId, null);
    assert.ok(f.log.recent().some(entry => entry.message === 'The shop.test:8080 profile is broken: "Download "a.zip" by clicking link "Download"" failed. Re-teach that step.'));
  } finally {
    f.close();
  }
});

test('run history keeps counts, the first failure and failed results with screenshots, newest first', () => {
  const f = fixture();
  try {
    f.history.add(runOf({ startedAt: '2026-10-23T10:00:00.000Z', results: [
      { stepId: 'a', label: 'Open', status: 'done', message: 'Done.', locator: null },
      { stepId: 'b', label: 'Item 3 › Download', status: 'failed', message: 'Not found.', locator: null, screenshot: '0b8f5a6e-0000-4000-8000-000000000000.png' },
      { stepId: 'c', label: 'Disabled', status: 'skipped', message: 'Disabled.', locator: null },
    ], status: 'failed', error: 'Step failed.', failure: { stepId: 'b', label: 'Download', url: 'http://shop.test/item/3' } }));
    f.history.add(runOf({ startedAt: '2026-10-23T11:00:00.000Z', results: [{ stepId: 'a', label: 'Open', status: 'done', message: 'Done.', locator: null }] }));
    const [newest, older] = f.history.recent();
    assert.equal(newest.startedAt, '2026-10-23T11:00:00.000Z');
    assert.deepEqual([older.done, older.failed, older.skipped, older.status], [1, 1, 1, 'failed']);
    assert.equal(older.failures[0].screenshot, '0b8f5a6e-0000-4000-8000-000000000000.png');
    assert.deepEqual(older.failure, { stepId: 'b', label: 'Download', url: 'http://shop.test/item/3' });
    assert.ok(f.history.screenshots().has('0b8f5a6e-0000-4000-8000-000000000000.png'));
  } finally {
    f.close();
  }
});

test('the tray icon is a valid 32×32 RGBA PNG, and the allowlist accepts site names only', () => {
  const png = trayIconPng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [32, 32, 8, 6]);
  const idat = png.indexOf('IDAT', 0, 'latin1');
  const pixels = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(pixels.length, 32 * (1 + 32 * 4));
  assert.equal(safetySettingsSchema.safeParse({ allowlist: ['example.com', '*.files.example', '127.0.0.1:4173'], confirmRisky: true }).success, true);
  for (const bad of ['http://example.com', 'example.com/path', 'a b']) assert.equal(safetySettingsSchema.safeParse({ allowlist: [bad], confirmRisky: true }).success, false, bad);
});
