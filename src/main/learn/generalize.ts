import type { ListContext } from '../../shared/learn.js';
import type { Step } from '../../shared/types.js';
import { allSteps } from '../engine/steps.js';
import { choosePagination } from './pagination-detector.js';

// Turns "open the list → open ONE item → do things on the item page" into "for every item (on every page): do
// those things". Pure: it only rearranges compiled steps, using what the recorder saw on the list page at the moment
// the item was clicked (ListContext). Unit-tested in tests/app-unit/generalize.test.ts.
//
// The item click is the first click in the main tab's top frame that (a) the recorder recognized as one of several
// similar items and (b) opened a page (navigated or opened a tab). That click is replaced by an item loop; the steps
// after it, up to the next address-bar navigation, become the loop body and run in the "item" tab. When the list page
// showed a usable "next" control or numbered page links, the item loop is wrapped in a page loop as well.

export const DEFAULT_MAX_ITEMS = 5000;
export const DEFAULT_MAX_PAGES = 100;

export interface Generalization { steps: Step[]; notes: string[]; generalized: boolean }

type LoopItems = Extract<Step, { type: 'loop_items' }>;
type LoopPages = Extract<Step, { type: 'loop_pages' }>;

const MAIN = { tab: 'main', frames: [], shadowHosts: [] };

export function generalize(input: Step[], lists: Record<string, ListContext>): Generalization {
  const index = input.findIndex(step => step.type === 'click' && lists[step.id] !== undefined && step.target.tab === 'main'
    && step.target.frames.length === 0 && (step.waitFor?.navigation === true || step.params.opensTab !== undefined));
  if (index < 0) return { steps: input, notes: [], generalized: false };
  const steps = structuredClone(input);
  const click = steps[index] as Extract<Step, { type: 'click' }>;
  const list = lists[click.id];
  const notes: string[] = [];

  // The item page is where the click went: the same tab, or the tab it opened.
  const itemTab = click.params.opensTab ?? 'main';
  const after = steps.slice(index + 1);
  const end = after.findIndex(step => step.type === 'navigate');
  const body = end < 0 ? after : after.slice(0, end);
  if (end >= 0) {
    notes.push(`Left out ${after.length - end} step${after.length - end === 1 ? '' : 's'} recorded after you went to another address `
      + `(from "${after[end].label}"); everything up to there repeats for every item.`);
  }
  for (const step of body) if (step.target.tab === itemTab) step.target = { ...step.target, tab: 'item' };

  let counter = Math.max(0, ...[...allSteps(steps)].map(step => Number(step.id.replace(/^s/, '')) || 0));
  const { pattern, count, index: taught } = list.items;
  const loopItems: LoopItems = {
    id: `s${++counter}`, type: 'loop_items', label: 'Repeat for every item', enabled: true, locators: [],
    params: { pattern, listUrl: list.url, maxItems: DEFAULT_MAX_ITEMS, exclude: [], steps: body },
    target: { ...MAIN }, waitFor: null, timeoutMs: 30_000, onFail: 'abort',
  };
  notes.push(`Found ${count} items on the list (you opened number ${taught + 1}). ${pattern.description}`);
  if (body.length === 0) notes.push('Nothing was recorded on the item page, so the item loop only opens each item.');

  const before = steps.slice(0, index);
  const pagination = choosePagination(list.pagination, null);
  if (pagination.ok && before[0]?.type === 'navigate') {
    const loopPages: LoopPages = {
      id: `s${++counter}`, type: 'loop_pages', label: 'Repeat on every page', enabled: true, locators: [],
      params: { pagination: pagination.pattern, maxPages: DEFAULT_MAX_PAGES, steps: [loopItems] },
      target: { ...MAIN }, waitFor: null, timeoutMs: 30_000, onFail: 'abort',
    };
    notes.push(pagination.pattern.description);
    return { steps: [...before, loopPages], notes, generalized: true };
  }
  notes.push(pagination.ok
    ? 'The list repeats on one page only: the recording does not start with opening the list.'
    : `The list repeats on one page only. ${pagination.reason} Use "Repeat on every page" on the list to add pagination (infinite scroll is found that way).`);
  return { steps: [...before, loopItems], notes, generalized: true };
}
