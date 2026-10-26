import type { FoundItem, ItemPattern, ListContext } from '../../shared/learn.js';
import { nameOf } from '../aria.js';
import { isOwn, normalizeText } from '../dom.js';
import { markItems } from '../highlight.js';
import { CHROME, contentRoot } from './content.js';
import { analyzePagination } from './pagination.js';

// Item pattern inference: from the one item the user opened, find its siblings by structure.
//
// Climbing from the clicked link, every ancestor level is a candidate "item": its parent holds N children with the
// same tag that carry a link at the same child path. The level with the most such siblings is the item (cards in a
// grid, rows in a table, entries in a list). Only tag names are kept, so class renames and generated IDs between
// renders do not matter; site chrome (header, nav, aside, footer) is never part of a list, which keeps "popular
// posts" sidebars with identical markup out.

const MAX_ITEMS = 5000;
const TAG = /^[a-z][a-z0-9-]{0,63}$/;

const isHttp = (link: HTMLAnchorElement) => /^https?:/.test(link.href);

function linkIn(item: Element, path: string): HTMLAnchorElement | null {
  if (!path) return item.matches('a[href]') ? (item as HTMLAnchorElement) : null;
  try {
    return item.querySelector<HTMLAnchorElement>(`:scope > ${path}[href]`);
  } catch {
    return null; // a hand-edited pattern that is not a valid selector simply finds nothing
  }
}

const inContent = (root: Element, element: Element) => (root === element || root.contains(element)) && !element.closest(CHROME) && !isOwn(element);

interface Match { item: Element; link: HTMLAnchorElement }

// Every item of the pattern in the page's content, in document order, one per URL.
export function matchItems(document: Document, pattern: ItemPattern): { matches: Match[]; loose: boolean } {
  const root = contentRoot(document);
  const containers = [root, ...root.querySelectorAll(pattern.container)].filter(container =>
    container.localName === pattern.container && container.parentElement?.localName === pattern.parent && inContent(root, container));
  const collect = (pick: (item: Element) => HTMLAnchorElement | null) => {
    const seen = new Set<string>();
    const matches: Match[] = [];
    for (const container of containers) {
      for (const item of container.children) {
        if (item.localName !== pattern.item || isOwn(item)) continue;
        const link = pick(item);
        if (!link || !isHttp(link) || seen.has(link.href)) continue;
        seen.add(link.href);
        matches.push({ item, link });
        if (matches.length >= MAX_ITEMS) return matches;
      }
    }
    return matches;
  };
  const strict = collect(item => linkIn(item, pattern.link));
  if (strict.length) return { matches: strict, loose: false };
  // The link moved inside the item (an extra wrapper, a new heading level): use each item's first content link.
  const loose = collect(item => [...item.querySelectorAll<HTMLAnchorElement>('a[href]')].find(link => isHttp(link) && !link.closest(CHROME)) ?? null);
  return { matches: loose, loose: loose.length > 0 };
}

function titleOf(link: HTMLAnchorElement): string {
  const text = normalizeText(link.textContent ?? '') || nameOf(link) || link.href;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

const NOUNS: Record<string, string> = { tr: 'a table row', li: 'a list entry', article: 'a card', a: 'a link', section: 'a section', div: 'a block' };

export function describePattern(pattern: Omit<ItemPattern, 'description'>): string {
  const what = NOUNS[pattern.item] ?? `a <${pattern.item}> element`;
  const how = pattern.link ? `opened through its link (${pattern.link})` : 'which is itself the link to open';
  return `Each item is ${what} (<${pattern.item}> in <${pattern.container}>), ${how}.`;
}

export function findItems(document: Document, pattern: ItemPattern, highlight: boolean, exclude: string[]) {
  const { matches, loose } = matchItems(document, pattern);
  const items: FoundItem[] = matches.map(({ link }) => ({ url: link.href, title: titleOf(link) }));
  let highlighted = 0;
  if (highlight) {
    const excluded = new Set(exclude);
    highlighted = markItems(document, matches.map(({ item, link }, index) => ({
      element: item, label: String(index + 1), excluded: excluded.has(link.href),
    })));
  } else {
    markItems(document, []);
  }
  return { items, loose, highlighted };
}

// Called on a recorded click: is the clicked link one of many similar items? Returns the pattern, how many items
// the page has, and which one was clicked. Null for anything that is not a content link among siblings.
export function inferItems(document: Document, clicked: Element): ListContext['items'] | null {
  const link = clicked.closest('a[href]') as HTMLAnchorElement | null;
  const root = contentRoot(document);
  if (!link || !isHttp(link) || !inContent(root, link)) return null;
  let best: (Omit<ItemPattern, 'description'> & { count: number }) | null = null;
  const path: string[] = [];
  for (let node: Element = link; node !== root;) {
    const parent = node.parentElement;
    if (!parent || !parent.parentElement || !TAG.test(node.localName)) break;
    const linkPath = path.join(' > ');
    const count = [...parent.children].filter(child => child.localName === node.localName && linkIn(child, linkPath) !== null).length;
    // Strictly more siblings wins; on a tie the lower level (closer to the link) stays.
    if (count >= 2 && (!best || count > best.count) && TAG.test(parent.localName) && TAG.test(parent.parentElement.localName)) {
      best = { parent: parent.parentElement.localName, container: parent.localName, item: node.localName, link: linkPath, count };
    }
    path.unshift(node.localName);
    node = parent;
  }
  if (!best) return null;
  const { count: _count, ...shape } = best;
  const pattern: ItemPattern = { ...shape, description: describePattern(shape) };
  const { matches } = matchItems(document, pattern);
  const index = matches.findIndex(match => match.link.href === link.href);
  if (matches.length < 2 || index < 0) return null;
  return { pattern, count: matches.length, index };
}

export function listContext(document: Document, clicked: Element): ListContext | null {
  const items = inferItems(document, clicked);
  return items ? { url: document.location.href, items, pagination: analyzePagination(document) } : null;
}
