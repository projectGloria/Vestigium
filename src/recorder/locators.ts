import type { Locator } from '../shared/types.js';
import { contentText, nameOf, roleOf } from './aria.js';
import {
  type Root, elementsIn, isOwn, isStableId, nthOfType, queryUnique, rootOf, sameTagSiblings, segment, stableClasses,
} from './dom.js';

// Locator value formats (all human-readable, all resolved within one root: a document or one shadow root):
//   role         link "Field Notes 01"          role + JSON-quoted accessible name (name optional)
//   text         a "Field Notes 01"             tag + JSON-quoted text content
//   testid       [data-testid="x"] | #id | input[name="q"]   a CSS selector built only from test/identity attributes
//   css          #items > article:nth-of-type(1) > h3 > a
//   xpath        /html[1]/body[1]/div[2]/a[1]   positional path from the root
//   fingerprint  {"tag":"a",...}                JSON structural description, matched by similarity score
// role and text may carry " >> nth=K" (0-based) when the plain value matches several elements.

const NTH = / >> nth=(\d+)$/;
const TEST_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
const FINGERPRINT_ATTRIBUTES = ['type', 'name', 'role', 'href', 'title', 'alt', 'placeholder', 'aria-label'];

// ---------- building ----------

export function buildLocators(element: Element): Locator[] {
  const root = rootOf(element);
  const locators: Locator[] = [];
  const add = (strategy: Locator['strategy'], value: string, confidence: number) => {
    if (value && value.length <= 4096 && !locators.some(existing => existing.value === value)) {
      locators.push({ strategy, value, confidence: Math.round(confidence * 100) / 100 });
    }
  };

  const testid = testIdSelector(element, root);
  if (testid) add('testid', testid.value, testid.confidence);

  const role = roleOf(element);
  if (role) {
    const name = nameOf(element);
    const value = name ? `${role} ${JSON.stringify(name)}` : role;
    withNth(value, findByRole(root, role, name), element, name ? 0.9 : 0.6, add.bind(null, 'role'));
  }

  const text = contentText(element);
  if (text && text.length <= 80 && !element.matches('input, select, textarea')) {
    const tag = element.localName;
    withNth(`${tag} ${JSON.stringify(text)}`, findByText(root, tag, text), element, 0.75, add.bind(null, 'text'));
  }

  const css = cssSelector(element, root);
  if (css) add('css', css.value, css.confidence);
  add('xpath', xpathOf(element, root), 0.3);
  add('fingerprint', JSON.stringify(fingerprintOf(element)), 0.4);

  return locators.sort((a, b) => b.confidence - a.confidence);
}

// Unique values keep full confidence; ambiguous ones get an index suffix and half confidence (position is fragile).
function withNth(value: string, matches: Element[], element: Element, confidence: number,
  add: (value: string, confidence: number) => void) {
  const index = matches.indexOf(element);
  if (index === -1) return;
  if (matches.length === 1) add(value, confidence);
  else add(`${value} >> nth=${index}`, confidence * 0.5);
}

function testIdSelector(element: Element, root: Root): { value: string; confidence: number } | null {
  const tag = CSS.escape(element.localName);
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) {
      const selector = `[${attribute}="${CSS.escape(value)}"]`;
      if (queryUnique(root, selector) === element) return { value: selector, confidence: 0.95 };
    }
  }
  if (element.id && isStableId(element.id)) {
    const selector = `#${CSS.escape(element.id)}`;
    if (queryUnique(root, selector) === element) return { value: selector, confidence: 0.9 };
  }
  const name = element.getAttribute('name');
  if (name && element.matches('input, select, textarea, button')) {
    const selector = `${tag}[name="${CSS.escape(name)}"]`;
    if (queryUnique(root, selector) === element) return { value: selector, confidence: 0.85 };
  }
  return null;
}

function cssSelector(element: Element, root: Root): { value: string; confidence: number } | null {
  const tag = CSS.escape(element.localName);
  // 1. The element alone, by tag + stable class(es).
  const classes = stableClasses(element);
  for (const combo of [...classes.map(name => [name]), ...pairs(classes)]) {
    const selector = `${tag}${combo.map(name => `.${CSS.escape(name)}`).join('')}`;
    if (queryUnique(root, selector) === element) return { value: selector, confidence: 0.7 };
  }
  // 2. A child-combinator path upward, anchored at the nearest ancestor with a stable ID (or the root).
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    if (current !== element && current.id && isStableId(current.id) && queryUnique(root, `#${CSS.escape(current.id)}`) === current) {
      parts.unshift(`#${CSS.escape(current.id)}`);
    } else {
      parts.unshift(segment(current, true));
    }
    const selector = parts.join(' > ');
    if (queryUnique(root, selector) === element) {
      return { value: selector, confidence: selector.includes(':nth-of-type') ? 0.5 : 0.6 };
    }
    if (parts[0].startsWith('#')) break;
    current = current.parentElement;
  }
  return null;
}

// A selector unique within the element's own root; used for shadow hosts, which must be found by plain CSS.
export function uniqueSelector(element: Element): string | null {
  const root = rootOf(element);
  return testIdSelector(element, root)?.value ?? cssSelector(element, root)?.value ?? null;
}

function pairs(items: string[]): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) result.push([items[i], items[j]]);
  return result.slice(0, 10);
}

export function xpathOf(element: Element, root: Root): string {
  const steps: string[] = [];
  let current: Element | null = element;
  // parentElement is null at a shadow root's top-level children and at <html>; both end the path.
  while (current && current.getRootNode() === root) {
    steps.unshift(`${current.localName}[${nthOfType(current)}]`);
    current = current.parentElement;
  }
  return `/${steps.join('/')}`;
}

export interface Fingerprint {
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  text: string;
  parents: string[];
  index: number;
  siblings: number;
}

export function fingerprintOf(element: Element): Fingerprint {
  const attributes: Record<string, string> = {};
  for (const name of FINGERPRINT_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 200);
  }
  const parents: string[] = [];
  for (let parent = element.parentElement; parent && parents.length < 3; parent = parent.parentElement) {
    parents.push(describeParent(parent));
  }
  return {
    tag: element.localName,
    id: element.id || null,
    classes: [...element.classList].slice(0, 10),
    attributes,
    text: contentText(element).slice(0, 80),
    parents,
    index: nthOfType(element),
    siblings: sameTagSiblings(element).length,
  };
}

const describeParent = (parent: Element) => [parent.localName, ...[...parent.classList].slice(0, 3)].join('.');

// ---------- matching ----------

// Returns every element the locator matches in `root`. Callers decide what ambiguity means.
export function findAll(root: Root, locator: Locator): Element[] {
  const nth = NTH.exec(locator.value);
  const value = nth ? locator.value.slice(0, nth.index) : locator.value;
  let matches: Element[];
  switch (locator.strategy) {
    case 'role': {
      const parsed = parseQuoted(value);
      matches = parsed ? findByRole(root, parsed.head, parsed.quoted) : [];
      break;
    }
    case 'text': {
      const parsed = parseQuoted(value);
      matches = parsed && parsed.quoted !== null ? findByText(root, parsed.head, parsed.quoted) : [];
      break;
    }
    case 'testid':
    case 'css':
      matches = selectAll(root, value);
      break;
    case 'xpath':
      matches = findByXPath(root, value);
      break;
    case 'fingerprint':
      matches = findByFingerprint(root, value);
      break;
  }
  if (!nth) return matches;
  const picked = matches[Number(nth[1])];
  return picked ? [picked] : [];
}

function parseQuoted(value: string): { head: string; quoted: string | null } | null {
  const space = value.indexOf(' ');
  if (space === -1) return { head: value, quoted: null };
  try {
    const quoted: unknown = JSON.parse(value.slice(space + 1));
    return typeof quoted === 'string' ? { head: value.slice(0, space), quoted } : null;
  } catch {
    return null;
  }
}

function findByRole(root: Root, role: string, name: string | null): Element[] {
  return elementsIn(root).filter(element => roleOf(element) === role && (name === null || nameOf(element) === name));
}

function findByText(root: Root, tag: string, text: string): Element[] {
  return elementsIn(root).filter(element => element.localName === tag && contentText(element) === text);
}

function selectAll(root: Root, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)].filter(element => !isOwn(element));
  } catch {
    return [];
  }
}

const POSITIONAL_XPATH = /^(\/[A-Za-z][\w.-]*\[[1-9]\d*\])+$/;

function findByXPath(root: Root, path: string): Element[] {
  if (POSITIONAL_XPATH.test(path)) {
    // Walk the positional path directly: works identically in documents and shadow roots,
    // where document.evaluate cannot be used as a context.
    let candidates: Element[] = [...root.children];
    let found: Element | null = null;
    for (const step of path.slice(1).split('/')) {
      const [, tag, index] = /^(.+)\[(\d+)\]$/.exec(step)!;
      found = candidates.filter(child => child.localName === tag)[Number(index) - 1] ?? null;
      if (!found) return [];
      candidates = [...found.children];
    }
    return found ? [found] : [];
  }
  // Hand-written XPath is still honored in documents.
  if (!(root instanceof Document)) return [];
  try {
    const result = root.evaluate(path, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const matches: Element[] = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i);
      if (node instanceof Element) matches.push(node);
    }
    return matches;
  } catch {
    return [];
  }
}

// Structural similarity, used when the attribute-based locators no longer match. Returns the single best
// candidate only when it is both similar enough and clearly better than the runner-up; otherwise nothing.
function findByFingerprint(root: Root, value: string): Element[] {
  let expected: Fingerprint;
  try {
    expected = JSON.parse(value) as Fingerprint;
  } catch {
    return [];
  }
  const scored = elementsIn(root)
    .filter(element => element.localName === expected.tag)
    .map(element => ({ element, score: similarity(expected, fingerprintOf(element)) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 0.7) return [];
  if (second && best.score - second.score < 0.1) return [];
  return [best.element];
}

export function similarity(expected: Fingerprint, actual: Fingerprint): number {
  let score = 0;
  let weight = 0;
  const part = (w: number, value: number) => {
    weight += w;
    score += w * value;
  };
  if (expected.id) part(3, expected.id === actual.id ? 1 : 0);
  part(2, jaccard(expected.classes, actual.classes));
  const keys = Object.keys(expected.attributes);
  if (keys.length) part(2, keys.filter(key => expected.attributes[key] === actual.attributes[key]).length / keys.length);
  if (expected.text) {
    const text = expected.text === actual.text ? 1 : actual.text && (actual.text.includes(expected.text) || expected.text.includes(actual.text)) ? 0.5 : 0;
    part(3, text);
  }
  if (expected.parents.length) {
    part(2, expected.parents.filter((parent, i) => actual.parents[i] === parent).length / expected.parents.length);
  }
  part(1, expected.index === actual.index && expected.siblings === actual.siblings ? 1 : expected.index === actual.index ? 0.5 : 0);
  return weight ? score / weight : 0;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const union = new Set([...a, ...b]);
  return a.filter(item => b.includes(item)).length / union.size;
}
