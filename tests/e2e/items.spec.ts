import { buildSync } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from '../support.js';
import type { PageEvent } from '../../src/shared/recorder.js';
import type { ItemPattern } from '../../src/shared/learn.js';
import { ITEMS } from '../demo-site/fixtures.js';
import type {} from './recorder-harness.js';

// Item pattern inference (src/recorder/learn/items.ts) through the production recorder core: what a recorded click
// on one item learns about the list, and how the pattern finds (and highlights) every item again.

const harness = buildSync({
  entryPoints: ['tests/e2e/recorder-harness.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
}).outputFiles[0].text;

async function setup(page: Page) {
  const events: PageEvent[] = [];
  await page.exposeBinding('__vestigiumSend', (_source, event: PageEvent) => { events.push(event); });
  await page.addInitScript({ content: harness });
  return events;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  const banner = page.getByRole('button', { name: 'Accept cookies' });
  if (await banner.isVisible()) await banner.click();
  await page.evaluate(() => window.__vestigium.arm(true));
}

// Clicks without leaving the page (the recorder listens in the capture phase, before this bubbling handler).
const stayOnPage = (page: Page) => page.evaluate(() => document.addEventListener('click', event => event.preventDefault()));
const titles = (from: number, to: number) => ITEMS.slice(from - 1, to).map(item => item.title);
const find = (page: Page, pattern: ItemPattern, highlight = true, exclude: string[] = []) =>
  page.evaluate(query => window.__vestigium.query(query), { kind: 'find-items' as const, pattern, highlight, exclude });
const clickList = (events: PageEvent[]) => events.filter((event): event is Extract<PageEvent, { kind: 'click' }> => event.kind === 'click');

test('a click on one card learns the card pattern: all 10 cards, which one was opened, and the pagination', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/list`);
  await page.getByRole('link', { name: 'Field Notes 03', exact: true }).click();
  await expect(page).toHaveURL(`${demo.origin}/item/3`);
  await expect.poll(() => clickList(events).length).toBe(1);
  const list = clickList(events)[0].list!;
  expect(list.url).toBe(`${demo.origin}/list`);
  expect(list.items).toEqual({
    pattern: { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'Each item is a card (<article> in <section>), opened through its link (h3 > a).' },
    count: 10, index: 2,
  });
  expect(list.pagination.next?.evidence).toEqual(['rel=next', 'text "Next →"']);
  // The pattern is tag-only: nothing from the fixture hooks or classes.
  const { description: _description, ...structure } = list.items.pattern;
  expect(JSON.stringify(structure)).not.toMatch(/card|grid|items|data-item-id/);

  // The same pattern finds every card again, in order, and outlines each one; the aside's identical "popular posts"
  // cards (43–45) are site chrome and never count.
  await open(page, `${demo.origin}/list`);
  const found = await find(page, list.items.pattern);
  expect(found.items.map(item => item.title)).toEqual(titles(1, 10));
  expect(found.items[0].url).toBe(`${demo.origin}/item/1`);
  expect(found).toMatchObject({ loose: false, highlighted: 10 });
  await page.screenshot({ path: test.info().outputPath('cards-highlighted.png') });
  // Highlighting draws nothing a locator or the content signature could pick up, and can be removed.
  expect(await page.evaluate(() => window.__vestigium.query({ kind: 'signature' }).then(signature => signature.links.length))).toBe(10);
  expect((await find(page, list.items.pattern, false)).highlighted).toBe(0);
});

test('a table row, a later page, load more and an SPA list all reuse the same pattern', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/list?layout=table`);
  await stayOnPage(page);
  await page.getByRole('link', { name: 'Field Notes 07', exact: true }).click();
  await expect.poll(() => clickList(events).length).toBe(1);
  const table = clickList(events)[0].list!.items;
  expect(table).toMatchObject({ pattern: { parent: 'table', container: 'tbody', item: 'tr', link: 'td > a' }, count: 10, index: 6 });
  expect(table.pattern.description).toBe('Each item is a table row (<tr> in <tbody>), opened through its link (td > a).');

  await open(page, `${demo.origin}/list?layout=table&page=5`);
  expect((await find(page, table.pattern)).items.map(item => item.title)).toEqual(titles(41, 47));

  const cards: ItemPattern = { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'cards' };
  await open(page, `${demo.origin}/list?mode=more`);
  expect((await find(page, cards)).items).toHaveLength(10);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(async () => (await find(page, cards)).items.length).toBe(20);

  await open(page, `${demo.origin}/list?mode=spa`);
  await page.getByRole('button', { name: 'Next ›' }).click();
  await expect.poll(async () => (await find(page, cards)).items[0]?.title).toBe(ITEMS[10].title);
});

test('class renames and wrappers do not break the pattern; excluded items are reported and marked', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/list`);
  const cards: ItemPattern = { parent: 'main', container: 'section', item: 'article', link: 'h3 > a', description: 'cards' };
  // A redeploy renames every class and ID.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('main *')) {
      element.removeAttribute('id');
      element.setAttribute('class', `x${Math.random().toString(36).slice(2, 8)}`);
    }
  });
  const renamed = await find(page, cards, true, [`${demo.origin}/item/2`]);
  expect(renamed.items.map(item => item.title)).toEqual(titles(1, 10));
  expect(renamed).toMatchObject({ loose: false, highlighted: 10 });
  // The link moves one level deeper: the exact path no longer matches, each card's first link is used instead.
  await page.evaluate(() => {
    for (const link of document.querySelectorAll('main article h3 > a')) link.replaceWith(Object.assign(document.createElement('span'), { innerHTML: link.outerHTML }));
  });
  const wrapped = await find(page, cards);
  expect(wrapped.items.map(item => item.title)).toEqual(titles(1, 10));
  expect(wrapped.loose).toBe(true);
});

test('clicks that are not items carry no list: chrome links, pagination, a lone button, the decoy sidebar', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/list`);
  await stayOnPage(page);
  await page.getByRole('navigation').first().getByRole('link', { name: 'Collection' }).click();
  await page.getByRole('navigation', { name: 'Pagination' }).getByRole('link', { name: '2', exact: true }).click();
  await page.getByRole('link', { name: 'Next →' }).click();
  await page.locator('aside').getByRole('link', { name: ITEMS[42].title }).click();
  await expect.poll(() => clickList(events).length).toBe(4);
  expect(clickList(events).map(event => event.list)).toEqual([undefined, undefined, undefined, undefined]);

  await open(page, `${demo.origin}/item/1`);
  await stayOnPage(page);
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  await expect.poll(() => clickList(events).length).toBe(5);
  expect(clickList(events)[4].list).toBeUndefined();
});
