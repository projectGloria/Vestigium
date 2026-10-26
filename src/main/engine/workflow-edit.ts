import type { WorkflowChange } from '../../shared/ipc.js';
import type { Step, Workflow } from '../../shared/types.js';
import type { PaginationPattern } from '../../shared/learn.js';
import { UserFacingError } from '../errors.js';
import { allSteps, findStep } from './steps.js';

// Applies one edit from the workflow panel. Pure: returns a new workflow with `version` bumped and leaves the input
// untouched. Structural validity (e.g. a popup used before the step that opens it) is checked by the caller's schema
// validation on save, so every edit path shares one set of rules. Steps are found at any nesting depth; moves stay
// within the step's own list (a loop body or the top level).
export function applyChange(workflow: Workflow, change: WorkflowChange): Workflow {
  const next = structuredClone(workflow);
  next.version = workflow.version + 1;
  if (change.kind === 'rename') {
    next.name = change.name;
    return next;
  }
  const found = findStep(next.steps, change.stepId);
  if (!found) throw new UserFacingError('That step no longer exists. The workflow may have been edited meanwhile.');
  const { list, index, step } = found;
  switch (change.kind) {
    case 'relabel':
      step.label = change.label;
      break;
    case 'toggle':
      step.enabled = change.enabled;
      break;
    case 'move': {
      const target = change.direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= list.length) {
        throw new UserFacingError(`That step is already ${change.direction === 'up' ? 'first' : 'last'}.`);
      }
      [list[index], list[target]] = [list[target], list[index]];
      break;
    }
    case 'delete-step':
      // Only the top level must keep a step; a loop body may be empty (a crawl that only visits pages).
      if (list === next.steps && next.steps.length === 1) {
        throw new UserFacingError('A workflow needs at least one step. Delete the whole workflow instead.');
      }
      list.splice(index, 1);
      break;
    case 'accept-review':
    case 'revert-review': {
      if (!step.review) throw new UserFacingError('That step has nothing to review.');
      if (change.kind === 'revert-review') step.locators = step.review.previous;
      delete step.review;
      break;
    }
    case 'set-max-pages':
      if (step.type !== 'loop_pages') throw new UserFacingError('Only a page loop has a page limit.');
      step.params.maxPages = change.maxPages;
      break;
    case 'set-max-items':
      if (step.type !== 'loop_items') throw new UserFacingError('Only an item loop has an item limit.');
      step.params.maxItems = change.maxItems;
      break;
    case 'exclude-item': {
      if (step.type !== 'loop_items') throw new UserFacingError('Only an item loop has items to exclude.');
      const others = step.params.exclude.filter(url => url !== change.url);
      step.params.exclude = change.excluded ? [...others, change.url] : others;
      break;
    }
  }
  return next;
}

// Wraps the workflow in a page loop: the opening navigation stays in front, everything after it runs on every page.
// The pattern comes from main's own page analysis, never from the renderer.
export function addPageLoop(workflow: Workflow, pagination: PaginationPattern): Workflow {
  if ([...allSteps(workflow.steps)].some(step => step.type === 'loop_pages')) {
    throw new UserFacingError('This workflow already repeats on every page.');
  }
  const next = structuredClone(workflow);
  next.version = workflow.version + 1;
  const head = next.steps[0]?.type === 'navigate' ? next.steps.slice(0, 1) : [];
  const body = next.steps.slice(head.length);
  const used = new Set([...allSteps(next.steps)].map(step => step.id));
  let counter = used.size + 1;
  while (used.has(`s${counter}`)) counter++;
  const loop: Step = {
    id: `s${counter}`, type: 'loop_pages', label: 'Repeat on every page', enabled: true, locators: [],
    params: { pagination, maxPages: 100, steps: body },
    target: { tab: 'main', frames: [], shadowHosts: [] }, waitFor: null, timeoutMs: 30_000, onFail: 'abort',
  };
  next.steps = [...head, loop];
  return next;
}

// File names offered in the export dialog: Windows-safe and short. (Full filename templating is milestone 6.)
export function exportFileName(name: string): string {
  let base = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100);
  if (!base) base = 'workflow';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
  return `${base}.json`;
}
