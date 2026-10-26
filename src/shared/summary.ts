import type { Step, Workflow } from './types.js';

// The plain-language summary shown after recording (plan §1), e.g.
//   Page type: LIST. Each item is a card (<article> in <section>), opened through its link (h3 > a).
//   Open each item → Download "field-notes.zip" by clicking link "Download ZIP" (file type ZIP).
//   Next page: the link "Next →" (rel=next). Stops when it is missing or disabled, …
// Derived from the workflow itself, so it is always in step with what will run. Null when nothing was generalized.

type Loop<T extends 'loop_pages' | 'loop_items'> = Extract<Step, { type: T }>;

function find<T extends 'loop_pages' | 'loop_items'>(steps: Step[], type: T): Loop<T> | null {
  for (const step of steps) {
    if (step.type === type) return step as Loop<T>;
    if (step.type === 'loop_pages' || step.type === 'loop_items') {
      const inner = find(step.params.steps, type);
      if (inner) return inner;
    }
  }
  return null;
}

function action(step: Step): string {
  if (step.type !== 'download' || !step.params.filename) return step.label;
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(step.params.filename)?.[1];
  return extension ? `${step.label} (file type ${extension.toUpperCase()})` : step.label;
}

export function summarize(workflow: Workflow): string[] | null {
  const items = find(workflow.steps, 'loop_items');
  const pages = find(workflow.steps, 'loop_pages');
  if (!items && !pages) return null;
  const lines: string[] = [];
  if (items) {
    lines.push(`Page type: LIST. ${items.params.pattern.description}`);
    const body = items.params.steps.filter(step => step.enabled);
    lines.push(body.length ? `Open each item → ${body.map(action).join(' → ')}.` : 'Open each item (nothing else is done on the item page).');
    if (items.params.exclude.length) lines.push(`${items.params.exclude.length} item${items.params.exclude.length === 1 ? ' is' : 's are'} excluded.`);
  }
  if (pages) lines.push(pages.params.pagination.description);
  else lines.push('Only the first page of the list: no pagination was found when it was taught.');
  return lines;
}
