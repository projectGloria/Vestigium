import type { ElementCapture, LocatedPageEvent, RecordedEvent } from '../../shared/recorder.js';
import type { ListContext } from '../../shared/learn.js';
import type { Step, StepTarget, StepType } from '../../shared/types.js';
import { isBrowserUrl } from '../validation.js';

// Pure translation of a raw recording (page events + browser events, in arrival order) into workflow steps.
// No Electron, no I/O: everything that needs judgment about *what the user meant* lives here and is unit-tested.

export interface CompileResult {
  steps: Step[];
  // Human-readable notes about events that could not become steps (shown in the log after recording).
  notes: string[];
  // Step ID → what the list page looked like when that click opened one of its items (see learn/generalize.ts).
  lists: Record<string, ListContext>;
}

type Description = ElementCapture['description'];
type StepOf<T extends StepType> = Extract<Step, { type: T }>;

const TIMEOUTS: Partial<Record<StepType, number>> = { navigate: 30_000, download: 60_000 };
const DEFAULT_TIMEOUT = 15_000;
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

// Locators of the same element captured at different moments share their identity-based values.
function sameElement(a: { target: StepTarget; locators: Step['locators'] }, b: { target: StepTarget; locators: Step['locators'] }) {
  if (a.target.tab !== b.target.tab) return false;
  if (JSON.stringify(a.target.frames) !== JSON.stringify(b.target.frames)) return false;
  if (JSON.stringify(a.target.shadowHosts) !== JSON.stringify(b.target.shadowHosts)) return false;
  const identity = (locators: Step['locators']) =>
    new Set(locators.filter(item => item.strategy === 'testid' || item.strategy === 'role' || item.strategy === 'css').map(item => `${item.strategy}:${item.value}`));
  const left = identity(a.locators);
  return [...identity(b.locators)].some(value => left.has(value));
}

export function compileSteps(events: RecordedEvent[]): CompileResult {
  // Stable sort by main's arrival time; ties keep arrival order.
  const ordered = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(item => item.event);
  const steps: Step[] = [];
  const descriptions = new Map<string, Description>();
  const notes: string[] = [];
  const lists: Record<string, ListContext> = {};
  const knownTabs = new Set(['main']);
  // Per tab: the last user action since that tab's last navigation (a following page navigation is its result).
  const lastAction = new Map<string, number>();
  // Per tab: the last click-like step (candidate cause of a popup or download).
  const lastClick = new Map<string, number>();
  // Popup alias → index of the step that opened it.
  const openedBy = new Map<string, number>();
  let counter = 0;

  const base = <T extends StepType>(type: T, target: StepTarget, locators: Step['locators'], params: StepOf<T>['params']) => ({
    id: `s${++counter}`, type, label: type, enabled: true, locators, params, target,
    waitFor: null, timeoutMs: TIMEOUTS[type] ?? DEFAULT_TIMEOUT, onFail: 'retry' as const,
  }) as StepOf<T>;

  const push = (step: Step, description: Description | null) => {
    steps.push(step);
    if (description) descriptions.set(step.id, description);
    return steps.length - 1;
  };

  // Replace a step in place, keeping its ID (and therefore every map entry pointing at its index).
  const replace = (index: number, step: Step) => {
    steps[index] = { ...step, id: steps[index].id } as Step;
  };

  const targetOf = (event: LocatedPageEvent, capture: ElementCapture): StepTarget =>
    ({ tab: event.tab, frames: event.frames, shadowHosts: capture.shadowHosts });

  for (const event of ordered) {
    if (!knownTabs.has(event.tab)) continue; // Tabs not opened by a recorded step are not part of the workflow.
    switch (event.kind) {
      case 'navigate': {
        if (event.fromAddressBar) {
          if (!event.inPage && event.url !== 'about:blank' && isBrowserUrl(event.url)) {
            push(base('navigate', { tab: event.tab, frames: [], shadowHosts: [] }, [], { url: event.url }), null);
          }
          lastAction.delete(event.tab);
          break;
        }
        // A page navigation right after a user action is that action's effect: the step waits for it on replay.
        const cause = lastAction.get(event.tab);
        if (cause !== undefined) {
          steps[cause].waitFor = { ...steps[cause].waitFor, navigation: true };
          lastAction.delete(event.tab);
        }
        break;
      }
      case 'popup': {
        const cause = lastClick.get(event.tab);
        const step = cause === undefined ? undefined : steps[cause];
        if (step && (step.type === 'click' || step.type === 'download') && !step.params.opensTab) {
          step.params.opensTab = event.popup;
          knownTabs.add(event.popup);
          openedBy.set(event.popup, cause!);
        } else {
          notes.push(`A new tab (${event.popup}) opened without a recorded click; its steps were not recorded.`);
        }
        break;
      }
      case 'download': {
        // The click that caused it: in the same tab, or the click that opened this popup (auto-downloading popups).
        const cause = lastClick.get(event.tab) ?? openedBy.get(event.tab);
        const step = cause === undefined ? undefined : steps[cause];
        if (!step || (step.type !== 'click' && step.type !== 'download')) {
          notes.push(`A download of ${event.filename ?? 'a file'} did not follow a recorded click and was not recorded.`);
          break;
        }
        if (step.type === 'download') {
          notes.push(`One click started several downloads; only ${step.params.filename ?? 'the first'} is expected on replay.`);
          break;
        }
        const download = base('download', step.target, step.locators, {
          filename: event.filename, mimeType: event.mimeType, ...(step.params.opensTab ? { opensTab: step.params.opensTab } : {}),
        });
        download.waitFor = { ...step.waitFor, download: true };
        replace(cause!, download);
        break;
      }
      case 'sensitive':
      case 'captcha':
        break;
      case 'click': {
        const index = push(base('click', targetOf(event, event.target), event.target.locators, {}), event.target.description);
        if (event.list && event.frames.length === 0) lists[steps[index].id] = event.list;
        lastAction.set(event.tab, index);
        lastClick.set(event.tab, index);
        break;
      }
      case 'input':
      case 'key': {
        const target = targetOf(event, event.target);
        const locators = event.target.locators;
        const previousIndex = steps.length - 1;
        const previous = steps[previousIndex];
        const same = previous && sameElement(previous, { target, locators });
        if (event.kind === 'key' && same && previous.type === 'type' && !previous.params.key) {
          // Typing then Enter/Tab in the same field is one step: "type X and press Enter".
          previous.params.key = event.key;
          lastAction.set(event.tab, previousIndex);
          break;
        }
        const params = event.kind === 'input' ? { value: event.value } : { value: null, key: event.key };
        const step = base('type', target, locators, params);
        // Clicking into a text field only focused it; typing implies that.
        const focusClick = same && previous.type === 'click' && !previous.params.opensTab && TEXT_ROLES.has(event.target.description.role ?? '');
        if (focusClick) {
          replace(previousIndex, step);
          descriptions.set(steps[previousIndex].id, event.target.description);
          if (lastClick.get(event.tab) === previousIndex) lastClick.delete(event.tab);
          lastAction.set(event.tab, previousIndex);
        } else {
          lastAction.set(event.tab, push(step, event.target.description));
        }
        break;
      }
      case 'select': {
        const target = targetOf(event, event.target);
        const previousIndex = steps.length - 1;
        const previous = steps[previousIndex];
        // Keyboard changes on a <select> fire one change per arrow press; only the final choice matters.
        if (previous?.type === 'select' && sameElement(previous, { target, locators: event.target.locators })) {
          previous.params = { value: event.value, label: event.label };
          lastAction.set(event.tab, previousIndex);
          break;
        }
        const index = push(base('select', target, event.target.locators, { value: event.value, label: event.label }), event.target.description);
        lastAction.set(event.tab, index);
        break;
      }
      case 'scroll': {
        const target = event.target ? targetOf(event, event.target) : { tab: event.tab, frames: event.frames, shadowHosts: [] };
        const locators = event.target?.locators ?? [];
        const previous = steps[steps.length - 1];
        // Consecutive scrolls of the same container collapse into its final position.
        if (previous?.type === 'scroll' && (locators.length === 0
          ? previous.locators.length === 0 && previous.target.tab === target.tab && JSON.stringify(previous.target.frames) === JSON.stringify(target.frames)
          : sameElement(previous, { target, locators }))) {
          previous.params = { x: event.x, y: event.y };
        } else {
          push(base('scroll', target, locators, { x: event.x, y: event.y }), event.target?.description ?? null);
        }
        break;
      }
    }
  }

  for (const step of steps) step.label = labelFor(step, descriptions.get(step.id) ?? null);
  return { steps, notes, lists };
}

// ---------- plain-language labels ----------

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function what(description: Description | null): string {
  if (!description) return 'the element';
  if (description.role) return description.name ? `${description.role} "${clip(description.name, 60)}"` : description.role;
  return description.name ? `"${clip(description.name, 60)}"` : `<${description.tag}>`;
}

function field(description: Description | null): string {
  return description?.name ? `"${clip(description.name, 60)}"` : what(description);
}

function where(step: Step): string {
  const parts: string[] = [];
  if (step.target.tab !== 'main') parts.push(`in ${step.target.tab}`);
  const frame = step.target.frames.at(-1);
  if (frame) {
    let host = frame.url;
    try {
      host = new URL(frame.url).host || frame.url;
    } catch { /* about:srcdoc and similar stay as-is */ }
    parts.push(`inside a frame from ${clip(host, 60)}`);
  }
  if (step.target.shadowHosts.length) parts.push('inside a web component');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export function labelFor(step: Step, description: Description | null): string {
  let text: string;
  switch (step.type) {
    case 'navigate':
      text = `Open ${clip(step.params.url, 200)}`;
      break;
    case 'click':
      text = `Click ${what(description)}${step.params.opensTab ? `, which opens ${step.params.opensTab}` : ''}`;
      break;
    case 'type':
      text = step.params.value === null
        ? `Press ${step.params.key ?? 'Enter'} in ${field(description)}`
        : `Type "${clip(step.params.value, 60)}" into ${field(description)}${step.params.key ? ` and press ${step.params.key}` : ''}`;
      break;
    case 'select':
      text = `Select "${clip(step.params.label, 60)}" in ${field(description)}`;
      break;
    case 'scroll':
      text = step.locators.length ? `Scroll ${what(description)} to ${step.params.x}, ${step.params.y}` : `Scroll the page to ${step.params.x}, ${step.params.y}`;
      break;
    case 'download':
      text = `Download ${step.params.filename ? `"${clip(step.params.filename, 80)}"` : 'a file'} by clicking ${what(description)}`
        + (step.params.opensTab ? `, which opens ${step.params.opensTab}` : '');
      break;
    default:
      text = step.type;
  }
  return clip(text + where(step), 500);
}
