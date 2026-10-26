import type { Locator } from '../shared/types.js';
import type { RecorderAction, RecorderCommand, RecorderResult } from '../shared/recorder.js';
import { type Root, isEnabled, isVisible, queryUnique } from './dom.js';
import { contentText, nameOf, roleOf } from './aria.js';
import { buildLocators, findAll } from './locators.js';
import { flash } from './highlight.js';
import { heal } from './heal.js';
import { coveredBy, describeNode, dismissConsentBanner } from './obstruction.js';
import { settle } from './settle.js';
import { isCaptchaElement } from './learn/obstacles.js';

// `primary`: the best-ranked recorded locator matched. Otherwise the workflow has drifted and main refreshes it.
type Found = { element: Element; locator: Locator | null; primary: boolean; healed: string | null };
type Resolution = { ok: true; found: Found } | { ok: false; result: RecorderResult };

// Walks the recorded shadow-host chain from the document down to the root that holds the target.
function resolveRoot(document: Document, shadowHosts: string[]): Root | RecorderResult {
  let root: Root = document;
  for (const [depth, selector] of shadowHosts.entries()) {
    const host = queryUnique(root, selector);
    if (!host) return { status: 'not-found', message: `Shadow host ${depth + 1} (${selector}) was not found.` };
    // Closed shadow roots are not reachable from scripts, by design; the recorder never records into them.
    if (!host.shadowRoot) return { status: 'not-found', message: `Shadow host ${selector} has no open shadow root yet.` };
    root = host.shadowRoot;
  }
  return root;
}

const NTH = / >> nth=\d+$/;

// Position-based locators describe *where* something was, not *what* it was. When a list changes, the same
// position holds a different item, so these may only confirm an element, never contradict recorded identity.
function isPositional(locator: Locator): boolean {
  return locator.strategy === 'xpath' || locator.strategy === 'fingerprint' || NTH.test(locator.value)
    || (locator.strategy === 'css' && locator.value.includes(':nth-of-type('));
}

function parseQuoted(value: string): { head: string; quoted: string } | null {
  const space = value.indexOf(' ');
  if (space === -1) return null;
  try {
    const quoted: unknown = JSON.parse(value.slice(space + 1));
    return typeof quoted === 'string' ? { head: value.slice(0, space), quoted } : null;
  } catch {
    return null;
  }
}

// Returns a description of the mismatch when `element` is not what the recorded role/name or text say it was.
function contradiction(element: Element, locators: Locator[]): string | null {
  for (const locator of locators) {
    const parsed = parseQuoted(locator.value.replace(NTH, ''));
    if (!parsed) continue;
    if (locator.strategy === 'role') {
      const actual = `${roleOf(element) ?? element.localName} ${JSON.stringify(nameOf(element))}`;
      if (roleOf(element) !== parsed.head || nameOf(element) !== parsed.quoted) return `it is ${actual}, not the recorded ${parsed.head} ${JSON.stringify(parsed.quoted)}`;
    } else if (locator.strategy === 'text') {
      if (element.localName !== parsed.head || contentText(element) !== parsed.quoted) {
        return `its text is ${JSON.stringify(contentText(element).slice(0, 80))}, not the recorded ${JSON.stringify(parsed.quoted)}`;
      }
    }
  }
  return null;
}

// Plan §4: a captcha is for a person. The recorder never records a click on one, but a step recorded on another
// page can still match one on replay: ouo.io's first "Get Link" button *is* its reCAPTCHA trigger, with the same id
// and name as the plain "Get Link" on the page after it. So no command acts on (or reports as ready) an element
// inside a captcha widget; "not-ready" makes the runner pause for the person and wait until the page has moved on.
const CAPTCHA_TARGET: Resolution = { ok: false, result: { status: 'not-ready', message: 'The target is part of a captcha; only a person may click it.' } };

// Tries locators from most to least confident; the first one with exactly one match wins.
// An ambiguous locator is skipped rather than guessed: clicking the wrong element is worse than failing.
// With `heal`, a confident and unambiguous fuzzy match is the last resort (see heal.ts for its safety rules).
// `includeDisabled` returns disabled matches as found (for state queries that must tell "disabled" from "missing").
export function resolveTarget(document: Document,
  command: Pick<RecorderCommand, 'locators' | 'shadowHosts'> & { heal?: boolean; includeDisabled?: boolean }): Resolution {
  const root = resolveRoot(document, command.shadowHosts);
  if (!('querySelectorAll' in root)) return { ok: false, result: root };
  const ordered = [...command.locators].sort((a, b) => b.confidence - a.confidence);
  let hidden: Found | null = null;
  let rejected: string | null = null;
  for (const [rank, locator] of ordered.entries()) {
    const matches = findAll(root, locator);
    if (matches.length !== 1) continue;
    const found: Found = { element: matches[0], locator, primary: rank === 0, healed: null };
    if (isPositional(locator)) {
      const mismatch = contradiction(found.element, command.locators);
      if (mismatch) {
        rejected ??= `A position-based match was rejected: ${mismatch}.`;
        continue;
      }
    }
    // Scrolled-out elements still count as visible (they get scrolled into view before acting).
    if (isVisible(found.element)) {
      if (isCaptchaElement(found.element)) return CAPTCHA_TARGET;
      if (!isEnabled(found.element) && !command.includeDisabled) return { ok: false, result: { status: 'not-ready', message: `${describe(locator)} is disabled.` } };
      return { ok: true, found };
    }
    hidden ??= found;
  }
  if (hidden) return { ok: false, result: { status: 'not-ready', message: `${describe(hidden.locator!)} is not visible yet.` } };
  if (command.heal) {
    const healed = heal(root, command.locators);
    if (healed) {
      if (isCaptchaElement(healed.element)) return CAPTCHA_TARGET;
      if (!isEnabled(healed.element)) return { ok: false, result: { status: 'not-ready', message: `${healed.reason} It is disabled.` } };
      return { ok: true, found: { element: healed.element, locator: null, primary: false, healed: healed.reason } };
    }
  }
  const message = 'No recorded locator matched exactly one element.';
  return { ok: false, result: { status: 'not-found', message: rejected ? `${message} ${rejected}` : message } };
}

function describe(locator: Locator): string {
  return `Element (${locator.strategy}: ${locator.value.slice(0, 80)})`;
}

const INTERACTIVE: ReadonlySet<RecorderAction['kind']> = new Set(['locate', 'click', 'type', 'select']);

export async function runCommand(document: Document, command: RecorderCommand): Promise<RecorderResult> {
  const window = document.defaultView;
  if (!window) return { status: 'error', message: 'The frame has no window.' };
  // A target-less scroll addresses the window itself.
  if (command.action.kind === 'scroll' && command.locators.length === 0) {
    window.scrollTo(command.action.x, command.action.y);
    return { status: 'done', strategy: 'window', value: 'window' };
  }
  let resolution = resolveTarget(document, command);
  if (!resolution.ok) return resolution.result;
  let banner: string | undefined;
  if (INTERACTIVE.has(command.action.kind)) {
    resolution.found.element.scrollIntoView({ block: 'center', inline: 'center' });
    await settle(resolution.found.element);
    // Frameworks often replace nodes during that wait; find the target again rather than act on a detached one.
    if (!resolution.found.element.isConnected) {
      resolution = resolveTarget(document, command);
      if (!resolution.ok) return resolution.result;
      resolution.found.element.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const cover = coveredBy(resolution.found.element);
    if (cover) {
      banner = dismissConsentBanner(cover) ?? undefined;
      const still = coveredBy(resolution.found.element);
      if (still) return { status: 'not-ready', message: `The target is covered by ${describeNode(still)}.` };
    }
  }
  const { element, locator, primary, healed } = resolution.found;
  if (command.highlight) flash(element);
  const outcome: RecorderResult & { status: 'done' } = locator
    ? { status: 'done', strategy: locator.strategy, value: locator.value }
    : { status: 'done', strategy: 'healed', value: `${roleOf(element) ?? element.localName} ${JSON.stringify(nameOf(element))}` };
  // The workflow drifted (fallback or heal): give main fresh locators built from the element actually used.
  if (!primary) outcome.refreshed = buildLocators(element);
  if (healed) outcome.healed = healed;
  if (banner) outcome.banner = banner;
  if (command.action.kind === 'locate') {
    const rect = element.getBoundingClientRect();
    outcome.point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return outcome;
  }
  try {
    perform(element, command.action);
  } catch (error) {
    return { status: 'error', message: `Action failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
  return outcome;
}

function perform(element: Element, action: RecorderAction) {
  switch (action.kind) {
    case 'none':
    case 'locate':
      return;
    case 'click':
      return click(element);
    case 'type':
      return type(element, action.value, action.key);
    case 'select':
      return select(element, action.value, action.label);
    case 'scroll':
      element.scrollTo(action.x, action.y);
      return;
  }
}

// Synthetic input: replicates the event sequence a real click produces. Used inside iframes; main-frame clicks
// use trusted OS-level input instead (action 'locate' + webContents.sendInputEvent in main).
function click(element: Element) {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView!;
  const init = {
    bubbles: true, cancelable: true, composed: true, view, button: 0,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(new view.PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
  element.dispatchEvent(new view.MouseEvent('mousedown', { ...init, buttons: 1 }));
  if (element instanceof view.HTMLElement) element.focus({ preventScroll: true });
  element.dispatchEvent(new view.PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
  element.dispatchEvent(new view.MouseEvent('mouseup', init));
  // HTMLElement.click() runs default actions (links, submit buttons, checkboxes) that a dispatched click would not.
  if (element instanceof view.HTMLElement) element.click();
  else element.dispatchEvent(new view.MouseEvent('click', init));
}

function type(element: Element, value: string | null, key: 'Enter' | 'Tab' | undefined) {
  const view = element.ownerDocument.defaultView!;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (!(element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement)) {
    throw new Error(`cannot type into a <${element.localName}>`);
  }
  element.focus({ preventScroll: true });
  // The prototype setter bypasses value trackers that frameworks (React) install on the instance,
  // so the framework sees the following input event as a real change.
  const prototype = element instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
  if (value !== null) {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
  }
  if (key) press(element, key);
}

function press(element: HTMLInputElement | HTMLTextAreaElement, key: 'Enter' | 'Tab') {
  const view = element.ownerDocument.defaultView!;
  const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
  const proceed = element.dispatchEvent(new view.KeyboardEvent('keydown', init));
  element.dispatchEvent(new view.KeyboardEvent('keyup', init));
  if (!proceed) return; // The page handled the key itself.
  // Synthetic key events have no default action, so reproduce the two defaults that matter.
  if (key === 'Enter' && element instanceof view.HTMLInputElement && element.form) element.form.requestSubmit();
  if (key === 'Tab') focusNext(element);
}

function focusNext(element: Element) {
  const document = element.ownerDocument;
  const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
    .filter(candidate => candidate.tabIndex >= 0 && !(candidate as HTMLButtonElement).disabled && isVisible(candidate));
  const next = focusable[focusable.indexOf(element as HTMLElement) + 1];
  next?.focus();
}

function select(element: Element, value: string, label: string) {
  const view = element.ownerDocument.defaultView!;
  if (!(element instanceof view.HTMLSelectElement)) throw new Error(`cannot select an option in a <${element.localName}>`);
  // Prefer the recorded value; fall back to the visible label if the site renumbered option values.
  const options = [...element.options];
  const option = options.find(candidate => candidate.value === value) ?? options.find(candidate => candidate.text.trim() === label);
  if (!option) throw new Error(`option "${label}" no longer exists`);
  element.focus({ preventScroll: true });
  element.value = option.value;
  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true }));
}
