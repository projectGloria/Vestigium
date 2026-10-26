import type { ControlCandidate, PaginationPattern, PaginationReport } from '../../shared/learn.js';

// Decides how a list moves to its next page, from what the page reported. Pure, so every rule is unit-tested.
//
// Preference: an enabled "next" control (works for links, buttons and SPA lists alike) → a URL pattern derived from
// numbered page links → an enabled "Load more" button → infinite scroll (only if scrolling actually loaded more).

export type PaginationChoice = { ok: true; pattern: PaginationPattern } | { ok: false; reason: string };

function control(candidate: ControlCandidate): string {
  const { role, name } = candidate.capture.description;
  return `the ${role ?? candidate.capture.description.tag} "${name ?? ''}"`;
}

// Finds the one place in the page URLs that carries the page number, e.g. "?page=2" or "/page/2/".
// Every numbered link must agree on the same template, or there is no reliable pattern.
export function urlTemplate(pages: { number: number; href: string }[]): string | null {
  const templates = new Map<string, number>();
  for (const { number, href } of pages) {
    // The number must stand alone between URL delimiters, so "/item/12" never matches page 1.
    const pattern = new RegExp(`(?<=[=/])${number}(?=$|[&/#?])`, 'g');
    const matches = href.match(pattern) ?? [];
    if (matches.length !== 1) continue;
    const template = href.replace(pattern, '{{page}}');
    templates.set(template, (templates.get(template) ?? 0) + 1);
  }
  const [best] = [...templates.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : null;
}

export function choosePagination(report: PaginationReport, probe: { before: number; after: number } | null): PaginationChoice {
  if (report.next && !report.next.disabled) {
    const { capture, evidence } = report.next;
    return {
      ok: true,
      pattern: {
        kind: 'next', locators: capture.locators, shadowHosts: capture.shadowHosts,
        description: `Next page: ${control(report.next)} (${evidence.join(', ')}). Stops when it is missing or disabled, when a page repeats, or when no new links appear.`,
      },
    };
  }
  const template = report.numbered.pages.length >= 2 ? urlTemplate(report.numbered.pages) : null;
  if (template) {
    return {
      ok: true,
      pattern: { kind: 'url', template, description: `Next page: open ${template} with the next page number. Stops when a page brings no new links.` },
    };
  }
  if (report.loadMore && !report.loadMore.disabled) {
    const { capture } = report.loadMore;
    return {
      ok: true,
      pattern: {
        kind: 'load-more', locators: capture.locators, shadowHosts: capture.shadowHosts,
        description: `More items: press ${control(report.loadMore)}. Stops when it is missing or disabled, or when it loads nothing new.`,
      },
    };
  }
  if (probe && probe.after > probe.before) {
    return {
      ok: true,
      pattern: { kind: 'infinite-scroll', description: 'More items: scroll to the bottom (infinite scroll). Stops when scrolling loads nothing new.' },
    };
  }
  if (report.next?.disabled) {
    return { ok: false, reason: 'This looks like the last page: its next control is disabled. Open the first page of the list and try again.' };
  }
  return {
    ok: false,
    reason: 'No pagination found on this page: no next link or button, no numbered pages, no "Load more" button, and scrolling to the bottom loaded nothing new.',
  };
}
