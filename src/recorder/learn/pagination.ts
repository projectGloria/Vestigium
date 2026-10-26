import type { ControlCandidate, PaginationReport } from '../../shared/learn.js';
import { nameOf } from '../aria.js';
import { describeElement } from '../capture.js';
import { elementsIn, isEnabled, isOwn, isVisible, normalizeText } from '../dom.js';
import { contentLinks } from './content.js';

// Finds the controls a list uses to move on: a "next" control, numbered page links, a "load more" button.
// Labels cover the languages in the plan; symbols (›, », →) work everywhere.

const CONTROL = 'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]';
const NEXT_WORDS = /^(next|next page|newer|older posts|more pages|sonraki|sonraki sayfa|ileri|siguiente|página siguiente|suivant|page suivante|weiter|nächste|nächste seite|successivo|próxima|volgende)$/i;
const NEXT_SYMBOLS = /^[›»→>]{1,2}$/;
const LOAD_MORE = /^(load more|show more|more results|see more|view more|load more results|daha fazla|daha fazla göster|mostrar más|cargar más|voir plus|afficher plus|mehr laden|mehr anzeigen|carica altri)\b/i;
const PAGINATION_CONTAINER = 'nav, [role="navigation"], .pagination, [class*="pager" i], [aria-label*="pagination" i], ul, ol';

// "Next →", "Next page »", "›": strip arrows and surrounding symbols before matching words.
function nextEvidence(element: Element): string[] {
  const evidence: string[] = [];
  if ((element.getAttribute('rel') ?? '').split(/\s+/).includes('next')) evidence.push('rel=next');
  const label = normalizeText(element.getAttribute('aria-label') ?? '');
  const name = nameOf(element);
  const stripped = name.replace(/[›»→>]+/g, '').trim();
  if (label && NEXT_WORDS.test(label.replace(/[›»→>]+/g, '').trim())) evidence.push(`label "${label}"`);
  if (stripped && NEXT_WORDS.test(stripped)) evidence.push(`text "${name}"`);
  else if (!stripped && NEXT_SYMBOLS.test(name)) evidence.push(`symbol "${name}"`);
  return evidence;
}

// Disabled controls are common at the last page: disabled attribute, aria-disabled, or a "disabled" class nearby.
export function looksDisabled(element: Element): boolean {
  if (!isEnabled(element)) return true;
  if (element.localName === 'a' && !element.getAttribute('href')) return true;
  const holder = element.closest('li, span, div') ?? element;
  return /\bdisabled\b/i.test(`${element.getAttribute('class') ?? ''} ${holder.getAttribute('class') ?? ''}`);
}

function candidate(element: Element, evidence: string[]): ControlCandidate | null {
  const capture = describeElement(element);
  if (!capture) return null;
  // rel=next is the strongest signal there is; give it a locator of its own at the top of the ranking.
  if (evidence.includes('rel=next') && element.localName === 'a') {
    capture.locators.unshift({ strategy: 'css', value: 'a[rel~="next"]', confidence: 0.97 });
  }
  return { capture, disabled: looksDisabled(element), evidence };
}

function numbered(document: Document): PaginationReport['numbered'] {
  // The container with the most purely numeric links is the page list.
  let best: { container: Element; links: HTMLAnchorElement[] } | null = null;
  for (const container of document.querySelectorAll(PAGINATION_CONTAINER)) {
    const links = [...container.querySelectorAll<HTMLAnchorElement>(':scope a[href]')]
      .filter(link => /^\d{1,5}$/.test(normalizeText(link.textContent ?? '')) && !isOwn(link));
    if (links.length >= 2 && (!best || links.length > best.links.length)) best = { container, links };
  }
  if (!best) return { current: null, pages: [] };
  const marked = best.container.querySelector('[aria-current="page"], .active, .current, [class*="current" i]');
  const current = marked ? Number(normalizeText(marked.textContent ?? '')) || null : null;
  const pages = [...new Map(best.links.map(link => [Number(normalizeText(link.textContent ?? '')), link.href])).entries()]
    .map(([number, href]) => ({ number, href }))
    .sort((a, b) => a.number - b.number);
  return { current, pages };
}

export function analyzePagination(document: Document): PaginationReport {
  const controls = elementsIn(document).filter(element => element.matches(CONTROL) && !isOwn(element) && isVisible(element));
  let next: ControlCandidate | null = null;
  let nextScore = -1;
  let loadMore: ControlCandidate | null = null;
  for (const element of controls) {
    const evidence = nextEvidence(element);
    if (evidence.length) {
      // Prefer: more evidence, inside a pagination container, enabled.
      const score = evidence.length * 2 + (element.closest(PAGINATION_CONTAINER) ? 1 : 0) + (looksDisabled(element) ? 0 : 1);
      if (score > nextScore) {
        const found = candidate(element, evidence);
        if (found) {
          next = found;
          nextScore = score;
        }
      }
      continue;
    }
    if (!loadMore && LOAD_MORE.test(nameOf(element))) loadMore = candidate(element, [`text "${nameOf(element)}"`]);
  }
  const root = document.scrollingElement ?? document.documentElement;
  return {
    url: document.location.href,
    next,
    loadMore,
    numbered: numbered(document),
    contentLinks: contentLinks(document).length,
    scrollable: root.scrollHeight > root.clientHeight + 50,
  };
}
