import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Step, Workflow } from '../../src/shared/types.js';
import { pageEventSchema } from '../../src/main/engine/workflow-schema.js';
import {
  MAX_WORKFLOW_BYTES, WorkflowFormatError, parseWorkflow, readWorkflowFile, serializeWorkflow, validateWorkflow,
  writeWorkflowFile,
} from '../../src/main/engine/workflow-json.js';
import { openDatabase } from '../../src/main/store/db.js';
import { repositories } from '../../src/main/store/repositories.js';

const main = { tab: 'main', frames: [], shadowHosts: [] };
const common = { enabled: true, waitFor: null, timeoutMs: 15_000, onFail: 'retry' as const };
const link = [
  { strategy: 'role' as const, value: 'link "Field Notes 01"', confidence: 0.95 },
  { strategy: 'text' as const, value: 'Field Notes 01', confidence: 0.8 },
  { strategy: 'css' as const, value: '#items article:nth-of-type(1) h3 > a', confidence: 0.6 },
];

// A realistic recording: list → item → download, plus a framed click, a shadow-DOM click, a popup and a reserved node.
function sample(): Workflow {
  const steps: Step[] = [
    { ...common, id: 's1', type: 'navigate', label: 'Open http://127.0.0.1:4173/list', locators: [], target: main,
      params: { url: 'http://127.0.0.1:4173/list' } },
    { ...common, id: 's2', type: 'click', label: 'Click link "Field Notes 01"', locators: link, target: main,
      params: {}, waitFor: { navigation: true } },
    { ...common, id: 's3', type: 'download', label: 'Download "field-notes.zip"', target: main,
      locators: [{ strategy: 'role', value: 'link "Download ZIP"', confidence: 0.95 }],
      params: { filename: 'field-notes.zip', mimeType: 'application/zip' }, waitFor: { download: true } },
    { ...common, id: 's4', type: 'click', label: 'Click button "Frame action"', params: {},
      locators: [{ strategy: 'testid', value: '#frame-action', confidence: 0.9 }],
      target: { tab: 'main', frames: [{ url: 'http://127.0.0.1:4174/lab/frame?label=Cross-origin', name: '', index: 1 }], shadowHosts: [] } },
    { ...common, id: 's5', type: 'click', label: 'Click button "Shadow action"', params: { opensTab: 'popup-1' },
      locators: [{ strategy: 'css', value: '#shadow-action', confidence: 0.85 }],
      target: { tab: 'main', frames: [], shadowHosts: ['lab-widget'] } },
    { ...common, id: 's6', type: 'type', label: 'Type "notes" into Search notes and press Enter', target: { ...main, tab: 'popup-1' },
      locators: [{ strategy: 'role', value: 'textbox "Search notes"', confidence: 0.95 }], params: { value: 'notes', key: 'Enter' } },
    { ...common, id: 's7', type: 'scroll', label: 'Scroll the page', locators: [], target: main, params: { x: 0, y: 1200 } },
    { ...common, id: 's8', type: 'condition', label: 'Reserved for a later milestone', locators: [], target: main, params: { anything: [1, 2] } },
    {
      ...common, id: 's9', type: 'loop_items', label: 'Repeat for every item', locators: [], target: main,
      params: {
        pattern: { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'Each item is a card.' },
        listUrl: 'http://127.0.0.1:4173/list', maxItems: 5000, exclude: ['http://127.0.0.1:4173/item/3'],
        steps: [{ ...common, id: 's10', type: 'download', label: 'Download', target: { ...main, tab: 'item' },
          locators: [{ strategy: 'role', value: 'link "Download ZIP"', confidence: 0.95 }],
          params: { filename: 'field-notes.zip', mimeType: 'application/zip' }, waitFor: { download: true } }],
      },
    },
  ];
  return {
    schemaVersion: 1, id: 'demo-workflow', name: 'Demo list download', siteProfileId: null, steps,
    variables: { page: 1 }, createdAt: '2026-10-23T12:00:00.000Z', version: 1,
  };
}

// Deep-clone, apply a mutation and expect a readable rejection mentioning `pattern`.
function rejects(mutate: (workflow: any) => void, pattern: RegExp) {
  const workflow = structuredClone(sample()) as any;
  mutate(workflow);
  assert.throws(() => validateWorkflow(workflow), (error: unknown) => {
    assert.ok(error instanceof WorkflowFormatError, 'expected a WorkflowFormatError');
    assert.match(error.message, pattern);
    return true;
  });
}

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, shuffleKeys(child)]));
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-'));
  return {
    directory,
    close() {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) {
        throw new Error('Refusing cleanup outside the temporary test directory.');
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a recorded workflow serializes to stable, readable JSON and round-trips exactly', () => {
  const workflow = sample();
  const text = serializeWorkflow(workflow);
  assert.deepEqual(parseWorkflow(text), workflow);
  // Key order comes from the canonical order, not from object construction order.
  assert.equal(serializeWorkflow(shuffleKeys(workflow) as Workflow), text);
  assert.ok(text.endsWith('}\n'));
  const topKeys = Object.keys(JSON.parse(text));
  assert.deepEqual(topKeys, ['schemaVersion', 'id', 'name', 'version', 'siteProfileId', 'createdAt', 'variables', 'steps']);
  const stepKeys = Object.keys(JSON.parse(text).steps[1]);
  assert.deepEqual(stepKeys, ['id', 'type', 'label', 'enabled', 'target', 'params', 'waitFor', 'timeoutMs', 'onFail', 'locators']);
  // Two-space indentation, one property per line: diffable by a human.
  assert.match(text, /^\{\n  "schemaVersion": 1,\n  "id": "demo-workflow",/);
  assert.match(text, /"label": "Click link \\"Field Notes 01\\""/);
});

test('unknown keys are rejected at every level', () => {
  rejects(workflow => { workflow.extra = true; }, /Unrecognized key/);
  rejects(workflow => { workflow.steps[1].script = 'alert(1)'; }, /steps\.1/);
  rejects(workflow => { workflow.steps[1].locators[0].note = 'x'; }, /steps\.1\.locators\.0/);
  rejects(workflow => { workflow.steps[1].params.evil = true; }, /steps\.1\.params/);
  rejects(workflow => { workflow.steps[3].target.frames[0].origin = 'x'; }, /steps\.3\.target\.frames\.0/);
});

test('types, ranges and enums are enforced with readable paths', () => {
  rejects(workflow => { workflow.schemaVersion = 2; }, /schemaVersion/);
  rejects(workflow => { workflow.steps[1].type = 'eval'; }, /steps\.1\.type/);
  rejects(workflow => { workflow.steps[1].locators[0].confidence = 1.5; }, /steps\.1\.locators\.0\.confidence/);
  rejects(workflow => { workflow.steps[1].locators[0].strategy = 'regex'; }, /strategy/);
  rejects(workflow => { workflow.steps[1].onFail = 'ignore'; }, /onFail/);
  rejects(workflow => { workflow.steps[1].timeoutMs = 0; }, /timeoutMs/);
  rejects(workflow => { workflow.steps[5].params.key = 'Escape'; }, /steps\.5\.params\.key/);
  rejects(workflow => { workflow.steps[6].params.y = -1; }, /steps\.6\.params\.y/);
  rejects(workflow => { workflow.createdAt = 'yesterday'; }, /createdAt/);
  rejects(workflow => { workflow.name = '   '; }, /name/);
  rejects(workflow => { workflow.id = '../escape'; }, /Workflow IDs/);
});

test('navigate steps accept only http(s) and about:blank without credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'https://user:pw@example.com/', 'data:text/html,x']) {
    rejects(workflow => { workflow.steps[0].params.url = url; }, /steps\.0\.params\.url/);
  }
  const workflow = sample();
  (workflow.steps[0].params as { url: string }).url = 'about:blank';
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('cross-step rules: locators required, unique IDs, popup tabs opened before use and only once', () => {
  rejects(workflow => { workflow.steps[1].locators = []; }, /steps\.1\.locators: A click step needs at least one locator/);
  rejects(workflow => { workflow.steps[2].locators = []; }, /A download step needs at least one locator/);
  rejects(workflow => { workflow.steps[2].id = 's1'; }, /steps\.2\.id: Duplicate step ID "s1"/);
  rejects(workflow => { workflow.steps[5].target.tab = 'popup-2'; }, /Tab "popup-2" is used before any step opens it/);
  rejects(workflow => { workflow.steps[4].params.opensTab = undefined; }, /Tab "popup-1" is used before/);
  rejects(workflow => { workflow.steps[1].params.opensTab = 'popup-1'; }, /Tab "popup-1" is opened twice/);
  rejects(workflow => { workflow.steps[5].target.tab = 'other'; }, /Tab must be "main", "item" or "popup-N"/);
});

test('reserved node types keep free-form params until their milestone defines them', () => {
  const workflow = sample();
  assert.deepEqual(validateWorkflow(workflow).steps[7].params, { anything: [1, 2] });
});

test('parseWorkflow reports syntax errors, accepts a UTF-8 BOM and refuses oversized input', () => {
  assert.throws(() => parseWorkflow('{"schemaVersion": 1,'), /not valid JSON/);
  assert.throws(() => parseWorkflow(JSON.stringify({ ...sample(), schemaVersion: 7 })), /schemaVersion 7 is not supported/);
  assert.deepEqual(parseWorkflow('\uFEFF' + serializeWorkflow(sample())), sample());
  assert.throws(() => parseWorkflow(' '.repeat(MAX_WORKFLOW_BYTES + 1)), /larger than 5 MiB/);
  // Many issues are summarized instead of dumping hundreds of lines on the user.
  const broken = sample() as any;
  for (const step of broken.steps) step.enabled = 'yes';
  assert.throws(() => validateWorkflow(broken), /; and 4 more problems$/);
});

test('workflow files are written atomically and read back; invalid data never reaches disk', async () => {
  const temp = temporaryDirectory();
  try {
    const path = join(temp.directory, 'workflow.json');
    await writeWorkflowFile(path, sample());
    assert.equal(readFileSync(path, 'utf8'), serializeWorkflow(sample()));
    assert.deepEqual(await readWorkflowFile(path), sample());
    // A failed write keeps the previous good file and leaves no temporary file behind.
    const invalid = { ...sample(), steps: [{ ...sample().steps[1], locators: [] }] } as Workflow;
    await assert.rejects(writeWorkflowFile(path, invalid), WorkflowFormatError);
    assert.equal(readFileSync(path, 'utf8'), serializeWorkflow(sample()));
    assert.deepEqual(readdirSync(temp.directory), ['workflow.json']);
    writeFileSync(join(temp.directory, 'big.json'), Buffer.alloc(MAX_WORKFLOW_BYTES + 1, 32));
    await assert.rejects(readWorkflowFile(join(temp.directory, 'big.json')), /larger than 5 MiB/);
    await assert.rejects(readWorkflowFile(temp.directory), /not a file/);
  } finally {
    temp.close();
  }
});

test('the workflows repository validates on save and on read', () => {
  const temp = temporaryDirectory();
  const db = openDatabase(join(temp.directory, 'store.sqlite'));
  try {
    const repo = repositories(db);
    repo.workflows.save(sample());
    assert.deepEqual(repo.workflows.get('demo-workflow'), sample());
    const invalid = { ...sample(), id: 'bad', steps: [{ ...sample().steps[1], locators: [] }] } as Workflow;
    assert.throws(() => repo.workflows.save(invalid), /A click step needs at least one locator/);
    assert.equal(repo.workflows.get('bad'), null);
    // A row corrupted outside the app is reported, not handed to the runner.
    db.prepare('UPDATE workflows SET document=? WHERE id=?').run(JSON.stringify({ ...sample(), steps: 'none' }), 'demo-workflow');
    assert.throws(() => repo.workflows.get('demo-workflow'), WorkflowFormatError);
  } finally {
    db.close();
    temp.close();
  }
});

test('recorder page events are strict; pages cannot claim a tab, frame or timestamp', () => {
  const target = { locators: [link[0]], shadowHosts: [], description: { tag: 'a', role: 'link', name: 'Field Notes 01' } };
  assert.equal(pageEventSchema.parse({ kind: 'click', target }).kind, 'click');
  assert.equal(pageEventSchema.parse({ kind: 'scroll', target: null, x: 0, y: 400 }).kind, 'scroll');
  for (const event of [
    { kind: 'click', target, tab: 'popup-1' },
    { kind: 'click', target, frames: [] },
    { kind: 'click', target, at: 1 },
    { kind: 'click', target: { ...target, locators: [] } },
    { kind: 'click', target: { ...target, description: { ...target.description, tag: '<script>' } } },
    { kind: 'key', target, key: 'Escape' },
    { kind: 'input', target, value: 'x'.repeat(10_001) },
    { kind: 'navigate', url: 'https://example.com' },
  ]) {
    assert.equal(pageEventSchema.safeParse(event).success, false, JSON.stringify(event).slice(0, 80));
  }
});

test('item loops: a tag-only pattern, http(s) URLs, and an "item" tab that exists only inside the loop', () => {
  assert.doesNotThrow(() => validateWorkflow(sample()));
  rejects(workflow => { workflow.steps[8].params.pattern.link = 'h3 > a.title'; }, /steps\.8\.params\.pattern\.link/);
  rejects(workflow => { workflow.steps[8].params.pattern.item = 'ARTICLE'; }, /steps\.8\.params\.pattern\.item/);
  rejects(workflow => { workflow.steps[8].params.pattern.class = 'card'; }, /Unrecognized key/);
  rejects(workflow => { workflow.steps[8].params.listUrl = 'javascript:alert(1)'; }, /steps\.8\.params\.listUrl/);
  rejects(workflow => { workflow.steps[8].params.exclude = ['file:///C:/x']; }, /steps\.8\.params\.exclude\.0/);
  rejects(workflow => { workflow.steps[8].params.maxItems = 0; }, /maxItems/);
  // The item tab is unknown outside the loop body.
  rejects(workflow => { workflow.steps[6].target.tab = 'item'; }, /steps\.6\.target\.tab: Tab "item" is used before any step opens it/);
  rejects(workflow => { workflow.steps[8].target.tab = 'popup-1'; }, /An item loop reads its list from the main tab/);
  rejects(workflow => {
    workflow.steps[8].params.steps.push({ ...structuredClone(workflow.steps[8]), id: 's11' });
  }, /An item loop cannot contain another item loop/);
});
