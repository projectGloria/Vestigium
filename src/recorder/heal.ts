import type { Locator } from '../shared/types.js';
import { contentText, nameOf, roleOf } from './aria.js';
import { type Root, elementsIn, isVisible, normalizeText } from './dom.js';
import { type Fingerprint, fingerprintOf, similarity } from './locators.js';

// Self-healing: when no recorded locator matches, look for the element the step most plausibly meant.
// A heal must be confident *and* unambiguous; failing a step is always better than acting on the wrong element.
//
// Signals: the recorded role + accessible name (or tag + text) and the structural fingerprint.
// Hard rule: numbers in the recorded name must appear unchanged ("Field Notes 10" never heals to "Field Notes 01",
// "Page 3" never to "Page 4"), because in lists and pagination numbers *are* the identity.

const NTH = / >> nth=\d+$/;
const MIN_SCORE = 0.7;
const MIN_NAME = 0.5;
const MIN_MARGIN = 0.15;

interface Identity { role: string | null; tag: string | null; name: string | null; fingerprint: Fingerprint | null }

function quoted(value: string): { head: string; text: string | null } {
  const clean = value.replace(NTH, '');
  const space = clean.indexOf(' ');
  if (space === -1) return { head: clean, text: null };
  try {
    const text: unknown = JSON.parse(clean.slice(space + 1));
    return { head: clean.slice(0, space), text: typeof text === 'string' ? text : null };
  } catch {
    return { head: clean.slice(0, space), text: null };
  }
}

function identityOf(locators: Locator[]): Identity {
  const identity: Identity = { role: null, tag: null, name: null, fingerprint: null };
  for (const locator of locators) {
    if (locator.strategy === 'role' && !identity.role) {
      const { head, text } = quoted(locator.value);
      identity.role = head;
      identity.name ??= text;
    } else if (locator.strategy === 'text' && !identity.tag) {
      const { head, text } = quoted(locator.value);
      identity.tag = head;
      identity.name ??= text;
    } else if (locator.strategy === 'fingerprint' && !identity.fingerprint) {
      try {
        identity.fingerprint = JSON.parse(locator.value) as Fingerprint;
      } catch { /* an unreadable fingerprint just contributes nothing */ }
    }
  }
  identity.tag ??= identity.fingerprint?.tag ?? null;
  return identity;
}

const numbers = (text: string) => (text.match(/\d+/g) ?? []).map(Number).sort((a, b) => a - b).join(',');

function bigrams(text: string): string[] {
  const padded = ` ${text} `;
  const result: string[] = [];
  for (let i = 0; i < padded.length - 1; i++) result.push(padded.slice(i, i + 2));
  return result;
}

function dice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      shared++;
      counts.set(item, count - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

// Blend of word overlap and character-pair overlap: robust to reordering ("ZIP download") and small edits ("Downloads").
export function textSimilarity(a: string, b: string): number {
  const left = normalizeText(a).toLowerCase();
  const right = normalizeText(b).toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 1;
  const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (dice(words(left), words(right)) + dice(bigrams(left), bigrams(right))) / 2;
}

export interface Heal { element: Element; reason: string }

export function heal(root: Root, locators: Locator[]): Heal | null {
  const identity = identityOf(locators);
  if (!identity.role && !identity.tag) return null;
  const expectedNumbers = identity.name ? numbers(identity.name) : '';
  const scored = elementsIn(root)
    .filter(element => (identity.role ? roleOf(element) === identity.role : element.localName === identity.tag) && isVisible(element))
    .map(element => {
      const actualName = identity.role ? nameOf(element) : contentText(element);
      if (identity.name && numbers(actualName) !== expectedNumbers) return null;
      const name = identity.name ? textSimilarity(identity.name, actualName) : 0;
      const structure = identity.fingerprint ? similarity(identity.fingerprint, fingerprintOf(element)) : 0.5;
      const score = identity.name ? 0.65 * name + 0.35 * structure : structure;
      return { element, name, score, actualName };
    })
    .filter(candidate => candidate !== null)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < MIN_SCORE) return null;
  if (identity.name && best.name < MIN_NAME) return null;
  if (second && best.score - second.score < MIN_MARGIN) return null;
  const was = identity.name ? `"${identity.name}"` : `the recorded <${identity.tag}>`;
  const now = best.actualName ? `"${best.actualName.slice(0, 80)}"` : `a <${best.element.localName}>`;
  return {
    element: best.element,
    reason: `No recorded locator matched; healed to ${identity.role ?? best.element.localName} ${now} (recorded as ${was}, ${Math.round(best.score * 100)}% similar).`,
  };
}
