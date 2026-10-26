import type { ElementCapture, PageEvent } from '../shared/recorder.js';
import { isCaptchaElement } from './learn/obstacles.js';
import type { ListContext } from '../shared/learn.js';
import { nameOf, roleOf } from './aria.js';
import { isOwn } from './dom.js';
import { outline } from './highlight.js';
import { buildLocators, uniqueSelector } from './locators.js';

// Turns trusted user input in one frame into PageEvents. Listeners are installed once, at document start and in the
// capture phase, so they run before page handlers that might stop propagation; they only emit while armed.

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option', '[onclick]', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
  '[role="option"]', '[role="switch"]', '[tabindex]:not([tabindex="-1"])',
].join(', ');
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']);
const SENSITIVE_AUTOCOMPLETE = /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/i;
const SENSITIVE_NAME = /pass(word|code|wd)?|pwd|cvv|cvc|card.?(num|no)|iban|ssn|secret|\botp\b|\bpin\b/i;

// User scroll intent must precede a scroll event; page-initiated scrolling (scrollIntoView, smooth anchors) is ignored.
const SCROLL_INTENT_MS = 1000;
const SCROLL_SETTLE_MS = 400;
// A click on a <label> makes the browser click its control too; that second click is the same user action.
const LABEL_ECHO_MS = 500;

export interface Capture {
  setArmed(armed: boolean): void;
  flush(): void;
}

interface Pending {
  at: number;
  emit(): void;
}

export function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.localName === 'textarea') return true;
  return element.localName === 'input' && TEXT_TYPES.has((element.getAttribute('type') ?? '').toLowerCase());
}

export function isSensitive(element: Element): boolean {
  if (element.localName !== 'input' && element.localName !== 'textarea') return false;
  if ((element.getAttribute('type') ?? '').toLowerCase() === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test(element.getAttribute('autocomplete') ?? '')) return true;
  const hints = ['name', 'id', 'aria-label', 'placeholder'].map(name => element.getAttribute(name) ?? '').join(' ');
  return SENSITIVE_NAME.test(hints) || [...((element as HTMLInputElement).labels ?? [])].some(label => SENSITIVE_NAME.test(label.textContent ?? ''));
}

export function describeElement(element: Element): ElementCapture | null {
  const shadowHosts: string[] = [];
  for (let root = element.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    const selector = uniqueSelector(root.host);
    if (!selector) return null; // Without a unique host path the target could not be found again.
    shadowHosts.unshift(selector);
  }
  return {
    locators: buildLocators(element),
    shadowHosts,
    description: { tag: element.localName.toLowerCase(), role: roleOf(element), name: nameOf(element) || null },
  };
}

// The innermost interactive element on the composed path (crosses open shadow roots); falls back to the raw target.
function interactiveTarget(event: Event): Element | null {
  const path = event.composedPath().filter((node): node is Element => node instanceof Element);
  for (const element of path) {
    if (element.localName === 'body' || element.localName === 'html') break;
    if (element.matches(INTERACTIVE)) return element;
  }
  return path[0] ?? null;
}

function originalTarget(event: Event): Element | null {
  const first = event.composedPath()[0];
  return first instanceof Element ? first : null;
}

function isFormControl(element: Element): boolean {
  return element.matches('input, select, textarea, button, [contenteditable=""], [contenteditable="true"]');
}

// A pointer press on a scrollbar: outside the client area of the scrollable element, or of the viewport.
function onScrollbar(event: PointerEvent, document: Document): boolean {
  const root = document.documentElement;
  if (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight) return true;
  const target = originalTarget(event);
  // Only scroll containers have scrollbars; inline elements report clientWidth 0 and must not qualify.
  if (!target || target.clientWidth === 0 || target.clientHeight === 0) return false;
  if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return false;
  const rect = target.getBoundingClientRect();
  return event.clientX >= rect.left + target.clientLeft + target.clientWidth
    || event.clientY >= rect.top + target.clientTop + target.clientHeight;
}

// `listOf` (top frame only) tells whether a clicked link is one of many similar items; injected to keep page analysis
// out of this module.
export function installCapture(window: Window, emit: (event: PageEvent) => void, listOf?: (element: Element) => ListContext | null): Capture {
  const document = window.document;
  let armed = false;
  let scrollIntentAt = 0;
  let labelEcho: { control: Element; at: number } | null = null;
  const pending = new Map<unknown, Pending>();
  const reportedSensitive = new WeakSet<Element>();

  const flush = () => {
    const ordered = [...pending.values()].sort((a, b) => a.at - b.at);
    pending.clear();
    for (const item of ordered) item.emit();
  };
  const flushOne = (key: unknown) => {
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    item.emit();
  };
  const sensitive = (element: Element) => {
    if (reportedSensitive.has(element)) return;
    reportedSensitive.add(element);
    emit({ kind: 'sensitive' });
  };
  const send = (element: Element, build: (target: ElementCapture) => PageEvent) => {
    const target = describeElement(element);
    if (target) emit(build(target));
  };
  // Every listener: ignore when disarmed, ignore synthetic (page-script) events, ignore the recorder's own overlay.
  const accept = (event: Event, element: Element | null): element is Element =>
    armed && event.isTrusted && element !== null && !isOwn(element);

  const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void) =>
    window.addEventListener(type, handler, { capture: true });

  // Scroll intent is narrow on purpose: a click followed by page-driven scrolling (scrollIntoView, an automation
  // tool bringing the next target into view, a page reacting to the click) must not become a scroll step.
  for (const type of ['wheel', 'touchmove'] as const) listen(type, () => { scrollIntentAt = Date.now(); });
  listen('pointerdown', event => { if (onScrollbar(event, document)) scrollIntentAt = Date.now(); });

  listen('click', event => {
    const element = interactiveTarget(event);
    if (!accept(event, element)) return;
    // Selects are recorded from their change event; clicking one only opens the native picker.
    if (element.matches('select, option') || element.closest('select')) return;
    if (isSensitive(element)) return sensitive(element);
    // A captcha is for a person to solve; recording the click would make a run click it (plan §4: never bypass).
    if (isCaptchaElement(element)) return emit({ kind: 'captcha' });
    if (labelEcho && labelEcho.control === element && Date.now() - labelEcho.at < LABEL_ECHO_MS) return;
    if (element instanceof HTMLLabelElement && element.control) labelEcho = { control: element.control, at: Date.now() };
    flush();
    // Analyzed now, synchronously: the click may navigate away before anything else could look at the list.
    const list = listOf?.(element) ?? null;
    send(element, target => (list ? { kind: 'click', target, list } : { kind: 'click', target }));
  });

  listen('input', event => {
    const element = originalTarget(event);
    if (!accept(event, element) || !isTextField(element)) return;
    if (isSensitive(element)) return sensitive(element);
    const field = element;
    // Capture the element now (it may be gone by flush time) and read the value at flush time (the final text).
    const existing = pending.get(field);
    if (existing) return;
    const target = describeElement(field);
    if (!target) return;
    pending.set(field, { at: Date.now(), emit: () => emit({ kind: 'input', target, value: field.value }) });
  });

  listen('change', event => {
    const element = originalTarget(event);
    if (!accept(event, element)) return;
    if (element instanceof HTMLSelectElement) {
      flush();
      const option = element.selectedOptions[0];
      send(element, target => ({ kind: 'select', target, value: element.value, label: option?.text.trim() ?? '' }));
    } else if (isTextField(element)) {
      flushOne(element);
    }
  });

  listen('keydown', event => {
    // Arrow keys and Space inside form controls change the control, not the scroll position.
    const focused = originalTarget(event);
    if (SCROLL_KEYS.has(event.key) && !(focused && isFormControl(focused))) scrollIntentAt = Date.now();
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    const element = originalTarget(event);
    // Only keys in text fields carry meaning for replay (submit / next field); elsewhere they produce clicks or focus moves.
    if (!accept(event, element) || event.isComposing || !isTextField(element)) return;
    if (isSensitive(element)) return sensitive(element);
    flush();
    send(element, target => ({ kind: 'key', target, key: event.key as 'Enter' | 'Tab' }));
  });

  listen('focusout', event => {
    const element = originalTarget(event);
    if (element) flushOne(element);
  });

  // 'scroll' does not bubble, but capture-phase window listeners see scrolls of any element in this document.
  listen('scroll', event => {
    if (!armed || !event.isTrusted || Date.now() - scrollIntentAt > SCROLL_INTENT_MS) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element && isOwn(element)) return;
    const key = element ?? 'window';
    const previous = pending.get(key) as (Pending & { timer?: ReturnType<typeof setTimeout> }) | undefined;
    clearTimeout(previous?.timer);
    let done = false;
    // Runs from its settle timer or from an earlier flush, whichever comes first, and only once.
    const emitScroll = () => {
      if (done) return;
      done = true;
      clearTimeout(item.timer);
      if (pending.get(key) === item) pending.delete(key);
      if (!element) {
        emit({ kind: 'scroll', target: null, x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
      } else if (element.isConnected) {
        send(element, target => ({ kind: 'scroll', target, x: Math.round(element.scrollLeft), y: Math.round(element.scrollTop) }));
      }
    };
    const item: Pending & { timer?: ReturnType<typeof setTimeout> } = { at: previous?.at ?? Date.now(), emit: emitScroll };
    item.timer = setTimeout(emitScroll, SCROLL_SETTLE_MS);
    pending.set(key, item);
  });

  // Navigation away must not lose typed text or a final scroll position.
  listen('pagehide', () => flush());

  listen('mouseover', event => {
    if (!armed) return;
    const element = interactiveTarget(event);
    if (!element || isOwn(element)) return outline(null, null);
    const role = roleOf(element);
    const name = nameOf(element);
    outline(element, role ? (name ? `${role} "${name}"` : role) : element.localName);
  });

  return {
    setArmed(next: boolean) {
      // Disarming flushes first so text typed just before "Stop recording" is kept.
      if (!next) flush();
      armed = next;
    },
    flush,
  };
}
