import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementCapture, PageEvent, RecordedEvent } from '../../src/shared/recorder.js';
import type { FrameRef, Step } from '../../src/shared/types.js';
import { compileSteps } from '../../src/main/learn/step-compiler.js';
import { validateWorkflow } from '../../src/main/engine/workflow-json.js';

// Event-stream fixtures shaped like what main receives from the recorder and from WebContents/session events.
let clock = 0;
let xpathCounter = 0;
function element(role: string | null, name: string | null, id: string, tag = 'a', shadowHosts: string[] = []): ElementCapture {
  return {
    locators: [
      { strategy: 'testid', value: `#${id}`, confidence: 0.9 },
      ...(role ? [{ strategy: 'role' as const, value: name ? `${role} ${JSON.stringify(name)}` : role, confidence: 0.9 }] : []),
      // A distinct xpath per capture proves identity matching does not depend on position-based locators.
      { strategy: 'xpath', value: `/html[1]/body[1]/div[${++xpathCounter}]`, confidence: 0.3 },
    ],
    shadowHosts,
    description: { tag, role, name },
  };
}
const page = (event: PageEvent, tab = 'main', frames: FrameRef[] = []): RecordedEvent => ({ ...event, at: ++clock, tab, frames });
const go = (url: string, fromAddressBar = false, tab = 'main', inPage = false): RecordedEvent =>
  ({ kind: 'navigate', at: ++clock, tab, url, inPage, fromAddressBar });
const download = (tab = 'main', filename: string | null = 'field-notes.zip'): RecordedEvent =>
  ({ kind: 'download', at: ++clock, tab, url: 'http://127.0.0.1:4173/files/disposition', filename, mimeType: 'application/zip' });
const popup = (tab: string, alias: string): RecordedEvent => ({ kind: 'popup', at: ++clock, tab, popup: alias });

const link = (name: string, id = name.replace(/\W+/g, '-').toLowerCase()) => element('link', name, id);
const search = () => element('textbox', 'Search notes', 'q', 'input');

// Every compiled result must be a valid workflow, or it could never be saved.
function compile(events: RecordedEvent[]) {
  const result = compileSteps(events);
  validateWorkflow({
    schemaVersion: 1, id: 'compiled', name: 'Compiled', siteProfileId: null, steps: result.steps, variables: {},
    createdAt: '2026-10-23T12:00:00.000Z', version: 1,
  });
  return result;
}
const summary = (steps: Step[]) => steps.map(step => [step.type, step.label]);

test('list → item → download becomes navigate, click-and-wait, download', () => {
  const { steps, notes } = compile([
    go('http://127.0.0.1:4173/list', true),
    page({ kind: 'click', target: link('Field Notes 01') }),
    go('http://127.0.0.1:4173/item/1'),
    page({ kind: 'click', target: link('Download ZIP') }),
    download(),
  ]);
  assert.deepEqual(summary(steps), [
    ['navigate', 'Open http://127.0.0.1:4173/list'],
    ['click', 'Click link "Field Notes 01"'],
    ['download', 'Download "field-notes.zip" by clicking link "Download ZIP"'],
  ]);
  assert.deepEqual(steps.map(step => step.id), ['s1', 's2', 's3']);
  assert.deepEqual(steps[1].waitFor, { navigation: true });
  assert.deepEqual(steps[2].waitFor, { download: true });
  assert.deepEqual(steps[2].params, { filename: 'field-notes.zip', mimeType: 'application/zip' });
  assert.equal(steps[2].timeoutMs, 60_000);
  assert.equal(steps[2].locators[0].value, '#download-zip');
  assert.deepEqual(notes, []);
});

test('focus click + typing + Enter collapse into one type step that waits for the submit', () => {
  const field = search();
  const { steps } = compile([
    page({ kind: 'click', target: field }),
    page({ kind: 'input', target: search(), value: 'notes' }),
    page({ kind: 'key', target: search(), key: 'Enter' }),
    go('http://127.0.0.1:4173/lab?q=notes'),
  ]);
  assert.deepEqual(summary(steps), [['type', 'Type "notes" into "Search notes" and press Enter']]);
  assert.deepEqual(steps[0].params, { value: 'notes', key: 'Enter' });
  assert.deepEqual(steps[0].waitFor, { navigation: true });
});

test('a bare Enter keeps the field value; typing in a different field does not merge', () => {
  const { steps } = compile([
    page({ kind: 'key', target: search(), key: 'Enter' }),
    page({ kind: 'input', target: element('textbox', 'Author', 'author', 'input'), value: 'Ada' }),
    page({ kind: 'key', target: search(), key: 'Tab' }),
  ]);
  assert.deepEqual(summary(steps), [
    ['type', 'Press Enter in "Search notes"'],
    ['type', 'Type "Ada" into "Author"'],
    ['type', 'Press Tab in "Search notes"'],
  ]);
  assert.deepEqual(steps[0].params, { value: null, key: 'Enter' });
});

test('a click on a button is kept even when typing follows elsewhere; clicks on non-text fields are kept', () => {
  const { steps } = compile([
    page({ kind: 'click', target: element('button', 'Shadow action', 'shadow-action', 'button', ['lab-widget']) }),
    page({ kind: 'click', target: element('checkbox', 'Remember', 'remember', 'input') }),
    page({ kind: 'input', target: element('checkbox', 'Remember', 'remember', 'input'), value: 'on' }),
  ]);
  assert.deepEqual(summary(steps), [
    ['click', 'Click button "Shadow action" (inside a web component)'],
    ['click', 'Click checkbox "Remember"'],
    ['type', 'Type "on" into "Remember"'],
  ]);
  assert.deepEqual(steps[0].target.shadowHosts, ['lab-widget']);
});

test('selects, collapsing scrolls and frame-scoped clicks keep their order and location', () => {
  const frame = [{ url: 'http://127.0.0.1:4174/lab/frame?label=Cross-origin', name: '', index: 1 }];
  const box = () => element('region', 'Scroll area', 'scroll-box', 'div');
  const { steps } = compile([
    page({ kind: 'select', target: element('combobox', 'Tag', 'tag', 'select'), value: 'landscape', label: 'Landscape' }),
    page({ kind: 'select', target: element('combobox', 'Tag', 'tag', 'select'), value: 'architecture', label: 'Architecture' }),
    page({ kind: 'scroll', target: null, x: 0, y: 200 }),
    page({ kind: 'scroll', target: null, x: 0, y: 640 }),
    page({ kind: 'scroll', target: box(), x: 0, y: 300 }),
    page({ kind: 'scroll', target: box(), x: 0, y: 1420 }),
    page({ kind: 'click', target: element('button', 'Frame action', 'frame-action', 'button') }, 'main', frame),
    page({ kind: 'scroll', target: null, x: 0, y: 10 }),
  ]);
  assert.deepEqual(summary(steps), [
    ['select', 'Select "Architecture" in "Tag"'],
    ['scroll', 'Scroll the page to 0, 640'],
    ['scroll', 'Scroll region "Scroll area" to 0, 1420'],
    ['click', 'Click button "Frame action" (inside a frame from 127.0.0.1:4174)'],
    ['scroll', 'Scroll the page to 0, 10'],
  ]);
  assert.deepEqual(steps[0].params, { value: 'architecture', label: 'Architecture' });
  assert.deepEqual(steps[3].target.frames, frame);
});

test('a popup is opened by the click before it, and later steps target the popup alias', () => {
  const { steps } = compile([
    page({ kind: 'click', target: link('Open in new tab') }),
    popup('main', 'popup-1'),
    go('http://127.0.0.1:4174/popup', false, 'popup-1'),
    page({ kind: 'click', target: link('Continue') }, 'popup-1'),
  ]);
  assert.deepEqual(summary(steps), [
    ['click', 'Click link "Open in new tab", which opens popup-1'],
    ['click', 'Click link "Continue" (in popup-1)'],
  ]);
  assert.equal(steps[1].target.tab, 'popup-1');
  // The popup's own first load is not caused by an action inside the popup.
  assert.equal(steps[1].waitFor, null);
});

test('a download that starts by itself in a popup turns the opening click into the download step', () => {
  const { steps } = compile([
    page({ kind: 'click', target: link('Download ZIP') }),
    popup('main', 'popup-1'),
    go('http://127.0.0.1:4174/popup', false, 'popup-1'),
    download('popup-1'),
  ]);
  assert.deepEqual(summary(steps), [['download', 'Download "field-notes.zip" by clicking link "Download ZIP", which opens popup-1']]);
  assert.deepEqual(steps[0].params, { filename: 'field-notes.zip', mimeType: 'application/zip', opensTab: 'popup-1' });
});

test('SPA route changes attach to the click; unexplained events are dropped with notes', () => {
  const { steps, notes } = compile([
    go('about:blank', true),
    go('http://127.0.0.1:4173/lab', true),
    go('http://127.0.0.1:4173/lab/redirected'), // page-initiated, no preceding action
    page({ kind: 'click', target: link('View two') }),
    go('http://127.0.0.1:4173/lab/spa/two', false, 'main', true),
    page({ kind: 'sensitive' }),
    popup('main', 'popup-1'), // attributed to the "View two" click, the last click in main
    page({ kind: 'click', target: link('Elsewhere') }, 'popup-9'), // a tab no recorded step opened: ignored
    download('main', 'second.zip'),
    download('main', 'third.zip'),
  ]);
  assert.deepEqual(summary(steps), [
    ['navigate', 'Open http://127.0.0.1:4173/lab'],
    ['download', 'Download "second.zip" by clicking link "View two", which opens popup-1'],
  ]);
  assert.deepEqual(steps[1].waitFor, { navigation: true, download: true });
  assert.deepEqual(notes, ['One click started several downloads; only second.zip is expected on replay.']);

  const orphan = compile([popup('main', 'popup-1'), page({ kind: 'click', target: link('Inside') }, 'popup-1'), download('main')]);
  assert.deepEqual(orphan.steps, []);
  assert.deepEqual(orphan.notes, [
    'A new tab (popup-1) opened without a recorded click; its steps were not recorded.',
    'A download of field-notes.zip did not follow a recorded click and was not recorded.',
  ]);
});

test('an address-bar navigation ends the previous action: a later page navigation is not attributed to it', () => {
  const { steps } = compile([
    page({ kind: 'click', target: link('Field Notes 01') }),
    go('http://127.0.0.1:4173/list?page=2', true),
    go('http://127.0.0.1:4173/list?page=2&sorted=1'),
  ]);
  assert.deepEqual(summary(steps), [['click', 'Click link "Field Notes 01"'], ['navigate', 'Open http://127.0.0.1:4173/list?page=2']]);
  assert.equal(steps[0].waitFor, null);
});

test('events are ordered by arrival time, ties by arrival order; long values are clipped in labels', () => {
  const late = { ...page({ kind: 'click', target: link('Second') }), at: 1_000_000 } as RecordedEvent;
  const tieA = { ...page({ kind: 'click', target: link('First') }), at: 10 } as RecordedEvent;
  const tieB = { ...page({ kind: 'input', target: search(), value: 'x'.repeat(100) }), at: 10 } as RecordedEvent;
  const { steps } = compile([late, tieA, tieB]);
  assert.deepEqual(steps.map(step => step.label), [
    'Click link "First"',
    `Type "${'x'.repeat(59)}…" into "Search notes"`,
    'Click link "Second"',
  ]);
  assert.equal((steps[1].params as { value: string }).value.length, 100);
});
