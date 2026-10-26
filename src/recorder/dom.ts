// Small DOM helpers shared by capture, locator building and resolution. No dependencies, no globals beyond the DOM.

export type Root = Document | ShadowRoot;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Elements the recorder itself adds (the highlight overlay) are invisible to every locator query.
const ownNodes = new WeakSet<Element>();
export function markOwn(element: Element) {
  ownNodes.add(element);
}

export function isOwn(element: Element): boolean {
  return ownNodes.has(element);
}

export function rootOf(element: Element): Root {
  return element.getRootNode() as Root;
}

// All elements in one tree (document or a single shadow root), not descending into nested shadow roots.
export function elementsIn(root: Root): Element[] {
  return [...root.querySelectorAll('*')].filter(element => !isOwn(element));
}

export function queryUnique(root: Root, selector: string): Element | null {
  let matches: NodeListOf<Element>;
  try {
    matches = root.querySelectorAll(selector);
  } catch {
    return null; // An invalid selector (e.g. hand-edited) simply does not match.
  }
  const own = [...matches].filter(element => !isOwn(element));
  return own.length === 1 ? own[0] : null;
}

export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
  // checkVisibility also accounts for display:none / content-visibility on ancestors.
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function isEnabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled === true) return false;
  if (element.closest('fieldset:disabled') && element.matches('button, input, select, textarea')) return false;
  return element.closest('[aria-disabled="true"]') === null;
}

// Heuristics for identifiers that frameworks or build tools generate; these change between deploys or renders.
// Hex runs must contain a digit so ordinary words made of a-f letters ("feedback", "added") are not flagged.
const GENERATED_ID = /\d{4,}|(?=[a-f]*\d)[0-9a-f]{8,}|^:|^(ember|react|mui|radix|headlessui|rc|uid|vue)[-_:]|^[a-z]{1,2}\d+$|[-_]\d+$/i;
const GENERATED_CLASS = /(?=[a-f]*\d)[0-9a-f]{5,}|\d{3,}|^(css|sc|jsx|emotion|svelte|tw)-|__[a-zA-Z0-9]{5,}$|^_[a-zA-Z0-9]{5,}$|^[a-z]{1,2}\d/i;
// State classes describe the moment of recording, not the element.
const STATE_CLASS = /^(is-|has-)?(active|hover|focus(ed)?|selected|open|current|visible|hidden|disabled|loading|show|in|collapsed|expanded)$/i;

export function isStableId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !GENERATED_ID.test(id);
}

export function stableClasses(element: Element): string[] {
  return [...element.classList].filter(name => name.length <= 40 && !GENERATED_CLASS.test(name) && !STATE_CLASS.test(name));
}

export function sameTagSiblings(element: Element): Element[] {
  const parent = element.parentElement ?? element.parentNode;
  if (!parent) return [element];
  return [...parent.children].filter(child => child.localName === element.localName);
}

export function nthOfType(element: Element): number {
  return sameTagSiblings(element).indexOf(element) + 1;
}

// One CSS selector segment for an element: tag, plus stable classes, plus :nth-of-type only when needed among siblings.
export function segment(element: Element, withClasses: boolean): string {
  const tag = CSS.escape(element.localName);
  const classes = withClasses ? stableClasses(element).slice(0, 2).map(name => `.${CSS.escape(name)}`).join('') : '';
  const siblings = sameTagSiblings(element);
  const matching = classes ? siblings.filter(sibling => sibling.matches(`${tag}${classes}`)) : siblings;
  return matching.length > 1 ? `${tag}${classes}:nth-of-type(${nthOfType(element)})` : `${tag}${classes}`;
}
