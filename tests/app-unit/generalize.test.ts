import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementCapture, PageEvent, RecordedEvent } from '../../src/shared/recorder.js';
import type { ControlCandidate, ListContext, PaginationReport } from '../../src/shared/learn.js';
import type { Step, Workflow } from '../../src/shared/types.js';
import { compileSteps } from '../../src/main/learn/step-compiler.js';
import { generalize } from '../../src/main/learn/generalize.js';
import { validateWorkflow } from '../../src/main/engine/workflow-json.js';
import { applyChange, addPageLoop } from '../../src/main/engine/workflow-edit.js';
import { summarize } from '../../src/shared/summary.js';

// From a recording of ONE item to a workflow that covers every item (and every page): pure rearrangement of the
// compiled steps, driven by what the recorder saw on the list page when the item was clicked.

let clock = 0;
const capture = (role: string, name: string, tag = 'a'): ElementCapture => ({
  locators: [{ strategy: 'role', value: `${role} ${JSON.stringify(name)}`, confidence: 0.95 }],
  shadowHosts: [], description: { tag, role, name },
});
const page = (event: PageEvent, tab = 'main'): RecordedEvent => ({ ...event, at: ++clock, tab, frames: [] });
const go = (url: string, fromAddressBar = false, tab = 'main'): RecordedEvent => ({ kind: 'navigate', at: ++clock, tab, url, inPage: false, fromAddressBar });
const download = (tab = 'main'): RecordedEvent =>
  ({ kind: 'download', at: ++clock, tab, url: 'http://127.0.0.1:4173/files/disposition', filename: 'field-notes.zip', mimeType: 'application/zip' });
const popup = (tab: string, alias: string): RecordedEvent => ({ kind: 'popup', at: ++clock, tab, popup: alias });

const control = (name: string, disabled = false, evidence = [`text "${name}"`]): ControlCandidate => ({
  capture: { locators: [{ strategy: 'css', value: 'a[rel~="next"]', confidence: 0.97 }], shadowHosts: [], description: { tag: 'a', role: 'link', name } },
  disabled, evidence,
});
const report = (overrides: Partial<PaginationReport> = {}): PaginationReport => ({
  url: 'http://127.0.0.1:4173/list', next: null, loadMore: null, numbered: { current: null, pages: [] }, contentLinks: 10, scrollable: true, ...overrides,
});
const PATTERN = { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'Each item is a card (<article> in <section>), opened through its link (h3 > a).' };
const list = (pagination = report({ next: control('Next →', false, ['rel=next', 'text "Next →"']) })): ListContext =>
  ({ url: 'http://127.0.0.1:4173/list', items: { pattern: PATTERN, count: 10, index: 2 }, pagination });

function learn(events: RecordedEvent[]) {
  const compiled = compileSteps(events);
  const result = generalize(compiled.steps, compiled.lists);
  // Every generalized workflow must still be a valid, saveable workflow.
  const workflow: Workflow = validateWorkflow({
    schemaVersion: 1, id: 'g', name: 'Generalized', siteProfileId: null, steps: result.steps, variables: {},
    createdAt: '2026-10-23T12:00:00.000Z', version: 1,
  });
  return { ...result, workflow };
}
type Loop<T extends 'loop_pages' | 'loop_items'> = Extract<Step, { type: T }>;
const shape = (steps: Step[]): unknown[] => steps.map(step =>
  step.type === 'loop_pages' || step.type === 'loop_items' ? [step.type, shape(step.params.steps)] : [step.type, step.target.tab]);

test('teach one item on a paginated list: navigate, then every page, then every item, then the download', () => {
  const { steps, notes, generalized, workflow } = learn([
    go('http://127.0.0.1:4173/list', true),
    page({ kind: 'click', target: capture('link', 'Field Notes 03'), list: list() }),
    go('http://127.0.0.1:4173/item/3'),
    page({ kind: 'click', target: capture('link', 'Download ZIP') }),
    download(),
  ]);
  assert.ok(generalized);
  assert.deepEqual(shape(steps), [['navigate', 'main'], ['loop_pages', [['loop_items', [['download', 'item']]]]]]);
  const pages = steps[1] as Loop<'loop_pages'>;
  const items = pages.params.steps[0] as Loop<'loop_items'>;
  assert.equal(pages.params.pagination.kind, 'next');
  assert.deepEqual(items.params.pattern, PATTERN);
  assert.equal(items.params.listUrl, 'http://127.0.0.1:4173/list');
  assert.deepEqual(items.params.exclude, []);
  // The item click itself is gone: the loop opens each item's own URL instead.
  assert.ok(![...JSON.stringify(steps).matchAll(/Field Notes 03/g)].length);
  assert.match(notes.join('\n'), /Found 10 items on the list \(you opened number 3\)/);
  assert.deepEqual(summarize(workflow), [
    `Page type: LIST. ${PATTERN.description}`,
    'Open each item → Download "field-notes.zip" by clicking link "Download ZIP" (file type ZIP).',
    pages.params.pagination.description,
  ]);
});

test('without usable pagination the item loop stands alone and says why', () => {
  const lastPage = report({ next: control('Next →', true) });
  const { steps, notes } = learn([
    go('http://127.0.0.1:4173/list?page=5', true),
    page({ kind: 'click', target: capture('link', 'Field Notes 43'), list: list(lastPage) }),
    go('http://127.0.0.1:4173/item/43'),
    page({ kind: 'click', target: capture('link', 'Download ZIP') }),
    download(),
  ]);
  assert.deepEqual(shape(steps), [['navigate', 'main'], ['loop_items', [['download', 'item']]]]);
  assert.match(notes.at(-1)!, /one page only\. This looks like the last page/);
  assert.match(notes.at(-1)!, /Repeat on every page/);
});

test('an item that opens in a new tab: that tab becomes the item tab; popups opened from it stay popups', () => {
  const { steps } = learn([
    go('http://127.0.0.1:4173/list', true),
    page({ kind: 'click', target: capture('link', 'Field Notes 01'), list: list(report()) }),
    popup('main', 'popup-1'),
    page({ kind: 'click', target: capture('link', 'Download on file host') }, 'popup-1'),
    popup('popup-1', 'popup-2'),
    page({ kind: 'click', target: capture('button', 'Continue', 'button') }, 'popup-2'),
    download('popup-2'),
  ]);
  assert.deepEqual(shape(steps), [['navigate', 'main'], ['loop_items', [['click', 'item'], ['download', 'popup-2']]]]);
  const items = steps[1] as Loop<'loop_items'>;
  assert.equal((items.params.steps[0] as Extract<Step, { type: 'click' }>).params.opensTab, 'popup-2');
});

test('steps before the item click run once; steps after leaving the item by address are left out with a note', () => {
  const { steps, notes } = learn([
    go('http://127.0.0.1:4173/list', true),
    page({ kind: 'scroll', target: null, x: 0, y: 400 }),
    page({ kind: 'click', target: capture('link', 'Field Notes 01'), list: list() }),
    go('http://127.0.0.1:4173/item/1'),
    page({ kind: 'click', target: capture('link', 'Download ZIP') }),
    download(),
    go('http://127.0.0.1:4173/list?page=2', true),
    page({ kind: 'click', target: capture('link', 'Field Notes 11') }),
  ]);
  assert.deepEqual(shape(steps), [['navigate', 'main'], ['scroll', 'main'], ['loop_pages', [['loop_items', [['download', 'item']]]]]]);
  assert.match(notes[0], /^Left out 2 steps recorded after you went to another address \(from "Open http:\/\/127\.0\.0\.1:4173\/list\?page=2"\)/);
});

test('nothing to generalize: no list context, a click that did not open a page, or a click inside a frame', () => {
  const plain = learn([go('http://127.0.0.1:4173/item/1', true), page({ kind: 'click', target: capture('link', 'Download ZIP') }), download()]);
  assert.equal(plain.generalized, false);
  assert.deepEqual(shape(plain.steps), [['navigate', 'main'], ['download', 'main']]);
  // A list link that only scrolled within the page (no navigation, no new tab) is just a click.
  const inPage = learn([go('http://127.0.0.1:4173/list', true), page({ kind: 'click', target: capture('link', 'Field Notes 01'), list: list() })]);
  assert.equal(inPage.generalized, false);
  // Framed lists are out of scope: the compiler drops their list context.
  const framed = compileSteps([
    go('http://127.0.0.1:4173/list', true),
    { kind: 'click', at: ++clock, tab: 'main', frames: [{ url: 'http://127.0.0.1:4174/frame', name: '', index: 0 }], target: capture('link', 'Field Notes 01'), list: list() },
    go('http://127.0.0.1:4173/item/1'),
  ]);
  assert.deepEqual(framed.lists, {});
});

test('item loop edits: exclude and include an item, cap the items; a page loop can be added around an item loop', () => {
  const { workflow } = learn([
    go('http://127.0.0.1:4173/list?page=5', true),
    page({ kind: 'click', target: capture('link', 'Field Notes 43'), list: list(report()) }),
    go('http://127.0.0.1:4173/item/43'),
    page({ kind: 'click', target: capture('link', 'Download ZIP') }),
    download(),
  ]);
  const loopId = workflow.steps[1].id;
  const url = 'http://127.0.0.1:4173/item/44';
  let next = applyChange(workflow, { kind: 'exclude-item', stepId: loopId, url, excluded: true });
  next = applyChange(next, { kind: 'exclude-item', stepId: loopId, url, excluded: true }); // idempotent
  assert.deepEqual((next.steps[1] as Loop<'loop_items'>).params.exclude, [url]);
  assert.match(summarize(next)!.join('\n'), /1 item is excluded\./);
  next = applyChange(next, { kind: 'exclude-item', stepId: loopId, url, excluded: false });
  assert.deepEqual((next.steps[1] as Loop<'loop_items'>).params.exclude, []);
  next = applyChange(next, { kind: 'set-max-items', stepId: loopId, maxItems: 3 });
  assert.equal((next.steps[1] as Loop<'loop_items'>).params.maxItems, 3);
  assert.throws(() => applyChange(next, { kind: 'set-max-items', stepId: next.steps[0].id, maxItems: 3 }), /Only an item loop/);
  assert.throws(() => applyChange(next, { kind: 'exclude-item', stepId: next.steps[0].id, url, excluded: true }), /Only an item loop/);
  // "Repeat on every page" later (e.g. infinite scroll): the item loop moves inside the new page loop.
  const paged = addPageLoop(next, { kind: 'infinite-scroll', description: 'More items: scroll to the bottom.' });
  assert.deepEqual(shape(paged.steps), [['navigate', 'main'], ['loop_pages', [['loop_items', [['download', 'item']]]]]]);
  assert.doesNotThrow(() => validateWorkflow(paged));
  // The item steps are found and edited at any depth.
  const download_ = (paged.steps[1] as Loop<'loop_pages'>).params.steps[0] as Loop<'loop_items'>;
  const toggled = applyChange(paged, { kind: 'toggle', stepId: download_.params.steps[0].id, enabled: false });
  assert.equal(((toggled.steps[1] as Loop<'loop_pages'>).params.steps[0] as Loop<'loop_items'>).params.steps[0].enabled, false);
  assert.match(summarize(toggled)!.join('\n'), /Open each item \(nothing else is done on the item page\)/);
});
