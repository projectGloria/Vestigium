import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlCandidate, PaginationReport } from '../../src/shared/learn.js';
import { choosePagination, urlTemplate } from '../../src/main/learn/pagination-detector.js';

const control = (name: string, disabled = false, evidence = [`text "${name}"`]): ControlCandidate => ({
  capture: { locators: [{ strategy: 'role', value: `link ${JSON.stringify(name)}`, confidence: 0.9 }], shadowHosts: [], description: { tag: 'a', role: 'link', name } },
  disabled, evidence,
});
const report = (overrides: Partial<PaginationReport>): PaginationReport => ({
  url: 'https://example.test/list', next: null, loadMore: null, numbered: { current: null, pages: [] }, contentLinks: 10, scrollable: true, ...overrides,
});
const pages = (...hrefs: string[]) => hrefs.map((href, index) => ({ number: index + 1, href }));

test('URL templates come from the one number that changes between page links', () => {
  assert.equal(urlTemplate(pages('https://x.test/list?page=1', 'https://x.test/list?page=2', 'https://x.test/list?page=3')), 'https://x.test/list?page={{page}}');
  assert.equal(urlTemplate(pages('https://x.test/blog/', 'https://x.test/blog/page/2/', 'https://x.test/blog/page/3/')), 'https://x.test/blog/page/{{page}}/');
  // Other numbers in the URL (category 12, page size 20) are left alone.
  assert.equal(urlTemplate(pages('https://x.test/c/12?size=20&p=1', 'https://x.test/c/12?size=20&p=2')), 'https://x.test/c/12?size=20&p={{page}}');
  // No consistent pattern (JavaScript links, unrelated targets): no template rather than a wrong one.
  assert.equal(urlTemplate(pages('https://x.test/a', 'https://x.test/b')), null);
  assert.equal(urlTemplate(pages('https://x.test/list?page=1')), null);
});

test('an enabled next control wins over numbered links and load more', () => {
  const choice = choosePagination(report({
    next: control('Next →', false, ['rel=next', 'text "Next →"']), loadMore: control('Load more'),
    numbered: { current: 1, pages: pages('https://x.test/list?page=1', 'https://x.test/list?page=2') },
  }), null);
  assert.ok(choice.ok);
  assert.equal(choice.pattern.kind, 'next');
  assert.equal(choice.pattern.description, 'Next page: the link "Next →" (rel=next, text "Next →"). Stops when it is missing or disabled, when a page repeats, or when no new links appear.');
});

test('a disabled next control falls back to the URL pattern, then load more, then a proven infinite scroll', () => {
  const numbered = { current: 5, pages: pages('https://x.test/list?page=1', 'https://x.test/list?page=2') };
  let choice = choosePagination(report({ next: control('Next', true), numbered }), null);
  assert.ok(choice.ok);
  assert.deepEqual(choice.pattern, { kind: 'url', template: 'https://x.test/list?page={{page}}', description: 'Next page: open https://x.test/list?page={{page}} with the next page number. Stops when a page brings no new links.' });

  choice = choosePagination(report({ loadMore: control('Load more') }), null);
  assert.ok(choice.ok);
  assert.equal(choice.pattern.kind, 'load-more');

  // A disabled load-more button and a scroll that loads nothing: no pagination.
  choice = choosePagination(report({ loadMore: control('Load more', true) }), { before: 10, after: 10 });
  assert.equal(choice.ok, false);

  choice = choosePagination(report({}), { before: 10, after: 20 });
  assert.ok(choice.ok);
  assert.equal(choice.pattern.kind, 'infinite-scroll');
});

test('readable refusals: last page, or nothing to paginate', () => {
  assert.deepEqual(choosePagination(report({ next: control('Next', true) }), { before: 10, after: 10 }), {
    ok: false, reason: 'This looks like the last page: its next control is disabled. Open the first page of the list and try again.',
  });
  assert.deepEqual(choosePagination(report({}), null), {
    ok: false,
    reason: 'No pagination found on this page: no next link or button, no numbered pages, no "Load more" button, and scrolling to the bottom loaded nothing new.',
  });
});
