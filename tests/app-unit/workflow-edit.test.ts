import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Step, Workflow } from '../../src/shared/types.js';
import { addPageLoop, applyChange, exportFileName } from '../../src/main/engine/workflow-edit.js';
import { validateWorkflow } from '../../src/main/engine/workflow-json.js';
import { WorkflowLibrary } from '../../src/main/engine/workflow-library.js';
import { UserFacingError } from '../../src/main/errors.js';
import { Logger } from '../../src/main/logger.js';
import { openDatabase } from '../../src/main/store/db.js';
import { repositories } from '../../src/main/store/repositories.js';

const main = { tab: 'main', frames: [], shadowHosts: [] };
const locators = (name: string) => [{ strategy: 'role' as const, value: `link "${name}"`, confidence: 0.9 }];
function sample(): Workflow {
  const steps: Step[] = [
    { id: 's1', type: 'navigate', label: 'Open the list', enabled: true, locators: [], params: { url: 'http://127.0.0.1:4173/list' }, target: main, waitFor: null, timeoutMs: 30_000, onFail: 'retry' },
    { id: 's2', type: 'click', label: 'Click link "Open"', enabled: true, locators: locators('Open'), params: { opensTab: 'popup-1' }, target: main, waitFor: null, timeoutMs: 15_000, onFail: 'retry' },
    { id: 's3', type: 'click', label: 'Click link "Inside"', enabled: true, locators: locators('Inside'), params: {}, target: { ...main, tab: 'popup-1' }, waitFor: null, timeoutMs: 15_000, onFail: 'retry' },
  ];
  return { schemaVersion: 1, id: 'wf', name: 'Sample', siteProfileId: null, steps, variables: {}, createdAt: '2026-10-23T12:00:00.000Z', version: 3 };
}

const refuses = (action: () => unknown, pattern: RegExp) =>
  assert.throws(action, (error: unknown) => error instanceof UserFacingError && pattern.test(error.message));

test('edits are pure, bump the version and touch only what they name', () => {
  const original = sample();
  const renamed = applyChange(original, { kind: 'rename', name: 'Collection download' });
  assert.equal(renamed.name, 'Collection download');
  assert.equal(renamed.version, 4);
  assert.equal(original.name, 'Sample');
  assert.equal(original.version, 3);
  assert.equal(applyChange(original, { kind: 'relabel', stepId: 's2', label: 'Open the item' }).steps[1].label, 'Open the item');
  assert.equal(applyChange(original, { kind: 'toggle', stepId: 's3', enabled: false }).steps[2].enabled, false);
  assert.deepEqual(applyChange(original, { kind: 'move', stepId: 's2', direction: 'up' }).steps.map(step => step.id), ['s2', 's1', 's3']);
  assert.deepEqual(applyChange(original, { kind: 'delete-step', stepId: 's1' }).steps.map(step => step.id), ['s2', 's3']);
  assert.deepEqual(original.steps.map(step => step.id), ['s1', 's2', 's3']);
});

test('impossible edits are refused with readable reasons', () => {
  refuses(() => applyChange(sample(), { kind: 'toggle', stepId: 'gone', enabled: true }), /no longer exists/);
  refuses(() => applyChange(sample(), { kind: 'move', stepId: 's1', direction: 'up' }), /already first/);
  refuses(() => applyChange(sample(), { kind: 'move', stepId: 's3', direction: 'down' }), /already last/);
  const single = { ...sample(), steps: [sample().steps[0]] };
  refuses(() => applyChange(single, { kind: 'delete-step', stepId: 's1' }), /Delete the whole workflow instead/);
});

test('export file names are Windows-safe', () => {
  assert.equal(exportFileName('Recording · 127.0.0.1:4173 · 2026-10-23 12:00'), 'Recording · 127.0.0.1-4173 · 2026-10-23 12-00.json');
  assert.equal(exportFileName('a/b\\c<d>e|f?g*h"i'), 'a-b-c-d-e-f-g-h-i.json');
  assert.equal(exportFileName('CON'), '_CON.json');
  assert.equal(exportFileName('  ...  '), 'workflow.json');
  assert.equal(exportFileName('trailing dots...'), 'trailing dots.json');
  assert.equal(exportFileName('x'.repeat(300)).length, 105);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-'));
  const db = openDatabase(join(directory, 'store.sqlite'));
  const log = new Logger(join(directory, 'logs'));
  const repo = repositories(db).workflows;
  repo.save(sample());
  return {
    directory, repo, library: new WorkflowLibrary(repo, log),
    close() {
      db.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) throw new Error('Refusing cleanup outside the temporary directory.');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('the library saves edits, rejects stale versions and edits that break the workflow', () => {
  const f = fixture();
  try {
    f.library.select('wf');
    const next = f.library.update('wf', 3, { kind: 'rename', name: 'Renamed' });
    assert.equal(next.version, 4);
    assert.equal(f.repo.get('wf')!.name, 'Renamed');
    assert.equal(f.library.selected()!.name, 'Renamed');
    assert.deepEqual(f.library.list().map(summary => summary.name), ['Renamed']);
    refuses(() => f.library.update('wf', 3, { kind: 'rename', name: 'Stale' }), /changed since it was displayed/);
    // Moving the popup step above the step that opens it would make replay impossible.
    refuses(() => f.library.update('wf', 4, { kind: 'move', stepId: 's3', direction: 'up' }),
      /^That change would break the workflow: steps\.1\.target\.tab: Tab "popup-1" is used before any step opens it\.$/);
    refuses(() => f.library.update('wf', 4, { kind: 'delete-step', stepId: 's2' }), /Tab "popup-1" is used before any step opens it/);
    assert.equal(f.repo.get('wf')!.version, 4); // refused edits are not saved
    f.library.remove('wf');
    assert.equal(f.library.selected(), null);
    assert.deepEqual(f.library.list(), []);
    refuses(() => f.library.remove('wf'), /no longer exists/);
  } finally {
    f.close();
  }
});

test('import gives a fresh ID (never overwrites) and refuses invalid files readably; export round-trips', async () => {
  const f = fixture();
  try {
    const path = join(f.directory, 'export.json');
    await f.library.exportTo('wf', path);
    const imported = await f.library.importFrom(path);
    assert.notEqual(imported.id, 'wf');
    assert.deepEqual({ ...imported, id: 'wf' }, sample());
    assert.equal(f.library.selected()!.id, imported.id);
    assert.equal(f.library.list().length, 2);
    const broken = join(f.directory, 'broken.json');
    writeFileSync(broken, readFileSync(path, 'utf8').replace('"onFail": "retry"', '"onFail": "explode"'));
    await assert.rejects(f.library.importFrom(broken), (error: unknown) =>
      error instanceof UserFacingError && /^Workflow is invalid: steps\.0\.onFail: Invalid option/.test(error.message));
    await assert.rejects(f.library.importFrom(join(f.directory, 'missing.json')), /The file could not be read/);
    assert.equal(f.library.list().length, 2);
  } finally {
    f.close();
  }
});

test('heals are saved with a review flag; repeated heals keep the original locators; keep/undo resolve the flag', () => {
  const f = fixture();
  try {
    const original = sample().steps[1].locators;
    const first = [{ strategy: 'role' as const, value: 'link "Open now"', confidence: 0.9 }];
    const second = [{ strategy: 'role' as const, value: 'link "Open it now"', confidence: 0.9 }];
    f.library.select('wf');
    f.library.heal('wf', 's2', first, 'healed once');
    f.library.heal('wf', 's2', second, 'healed twice');
    const healed = f.repo.get('wf')!;
    assert.equal(healed.version, 5);
    assert.deepEqual(healed.steps[1].locators, second);
    assert.equal(healed.steps[1].review!.reason, 'healed twice');
    assert.deepEqual(healed.steps[1].review!.previous, original); // undo goes back to what was recorded
    assert.equal(f.library.selected()!.version, 5); // the open workflow reflects the heal immediately

    const undone = applyChange(healed, { kind: 'revert-review', stepId: 's2' });
    assert.deepEqual(undone.steps[1].locators, original);
    assert.equal(undone.steps[1].review, undefined);
    const kept = applyChange(healed, { kind: 'accept-review', stepId: 's2' });
    assert.deepEqual(kept.steps[1].locators, second);
    assert.equal(kept.steps[1].review, undefined);
    refuses(() => applyChange(kept, { kind: 'accept-review', stepId: 's2' }), /nothing to review/);
    // A heal for a step that was deleted meanwhile is ignored rather than resurrecting it.
    f.library.heal('wf', 'gone', first, 'x');
    assert.equal(f.repo.get('wf')!.version, 5);
  } finally {
    f.close();
  }
});

const nextPattern = { kind: 'next' as const, locators: [{ strategy: 'css' as const, value: 'a[rel~="next"]', confidence: 0.97 }], shadowHosts: [], description: 'Next page: the link "Next →".' };

test('a page loop wraps everything after the opening navigation; nested steps can be edited in place', () => {
  const looped = addPageLoop(sample(), nextPattern);
  assert.deepEqual(looped.steps.map(step => step.type), ['navigate', 'loop_pages']);
  const loop = looped.steps[1] as Extract<Step, { type: 'loop_pages' }>;
  assert.equal(loop.id, 's4');
  assert.deepEqual(loop.params.steps.map(step => step.id), ['s2', 's3']);
  assert.equal(loop.params.maxPages, 100);
  assert.doesNotThrow(() => validateWorkflow(looped));
  refuses(() => addPageLoop(looped, nextPattern), /already repeats on every page/);

  const limited = applyChange(looped, { kind: 'set-max-pages', stepId: 's4', maxPages: 3 });
  assert.equal((limited.steps[1] as typeof loop).params.maxPages, 3);
  refuses(() => applyChange(looped, { kind: 'set-max-pages', stepId: 's1', maxPages: 3 }), /Only a page loop/);
  const relabeled = applyChange(looped, { kind: 'relabel', stepId: 's3', label: 'Inside the loop' });
  assert.equal((relabeled.steps[1] as typeof loop).params.steps[1].label, 'Inside the loop');
  // A loop body may become empty (a crawl that only visits pages); the top level may not.
  const emptied = applyChange(applyChange(looped, { kind: 'delete-step', stepId: 's3' }), { kind: 'delete-step', stepId: 's2' });
  assert.deepEqual((emptied.steps[1] as typeof loop).params.steps, []);
  assert.doesNotThrow(() => validateWorkflow(emptied));
});

test('nested validation: unique IDs everywhere, tabs scoped to the loop body, no loop in a loop, safe URL templates', () => {
  const looped = addPageLoop(sample(), nextPattern);
  const loop = () => looped.steps[1] as Extract<Step, { type: 'loop_pages' }>;
  const broken = (mutate: (workflow: Workflow) => void, pattern: RegExp) => {
    const copy = structuredClone(looped);
    mutate(copy);
    assert.throws(() => validateWorkflow(copy), pattern);
  };
  broken(copy => { (copy.steps[1] as ReturnType<typeof loop>).params.steps[0].id = 's1'; }, /steps\.1\.params\.steps\.0\.id: Duplicate step ID "s1"/);
  // The popup opened inside the body is not available after the loop.
  broken(copy => { copy.steps.push({ ...sample().steps[2], id: 's9' }); }, /steps\.2\.target\.tab: Tab "popup-1" is used before any step opens it/);
  broken(copy => { (copy.steps[1] as ReturnType<typeof loop>).params.steps.push({ ...structuredClone(loop()), id: 's8', params: { ...loop().params, steps: [] } }); },
    /A page loop cannot be inside another page loop/);
  for (const template of ['javascript:alert({{page}})', 'https://x.test/list?page=2', 'file:///C:/{{page}}']) {
    broken(copy => { (copy.steps[1] as ReturnType<typeof loop>).params.pagination = { kind: 'url', template, description: 'x' }; },
      /The URL template must be an http\(s\) URL containing \{\{page\}\}/);
  }
  broken(copy => { (copy.steps[1] as ReturnType<typeof loop>).params.maxPages = 0; }, /maxPages/);
});
