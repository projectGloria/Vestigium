import type { PageSignature } from '../../shared/learn.js';
import { isOwn } from '../dom.js';

// "Content" is what a list page is about: everything except site chrome (header, navigation, footer, sidebars),
// pagination controls and dialogs. Repeated chrome links would otherwise make every page look alike.
export const CHROME = [
  'header', 'nav', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[role="dialog"]', '[aria-label*="pagination" i]', '.pagination', '[class*="pager" i]',
].join(', ');

export function contentRoot(document: Document): Element {
  return document.querySelector('main, [role="main"]') ?? document.body ?? document.documentElement;
}

export function contentLinks(document: Document): HTMLAnchorElement[] {
  const root = contentRoot(document);
  return [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(link =>
    !isOwn(link) && !link.closest(CHROME) && /^https?:/.test(link.href));
}

// FNV-1a: tiny, dependency-free and good enough to tell page contents apart.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function signature(document: Document): PageSignature {
  const links = [...new Set(contentLinks(document).map(link => link.href))];
  return { hash: fnv1a(links.join('\n')), links: links.slice(0, 2000) };
}
