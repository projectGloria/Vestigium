import { buildSync } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from '../support.js';
import type {} from './recorder-harness.js';

// Page-side learning analysis (src/recorder/learn) against the demo lists, through the production recorder core.
const harness = buildSync({
  entryPoints: ['tests/e2e/recorder-harness.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
}).outputFiles[0].text;

async function open(page: Page, url: string) {
  await page.addInitScript({ content: harness });
  await page.goto(url);
  const banner = page.getByRole('button', { name: 'Accept cookies' });
  if (await banner.isVisible()) await banner.click();
}

const analyze = (page: Page) => page.evaluate(() => window.__vestigium.query({ kind: 'analyze-pagination' }));

test('numbered pages with a Next link: rel=next wins, numbered links are listed, the last page shows it disabled', async ({ page, demo }) => {
  await open(page, `${demo.origin}/list`);
  const report = await analyze(page);
  expect(report.next).toMatchObject({ disabled: false, evidence: ['rel=next', 'text "Next →"'] });
  expect(report.next!.capture.locators[0]).toEqual({ strategy: 'css', value: 'a[rel~="next"]', confidence: 0.97 });
  expect(report.numbered.current).toBe(1);
  expect(report.numbered.pages.map(page => page.number)).toEqual([1, 2, 3, 4, 5]);
  expect(report.numbered.pages[1].href).toBe(`${demo.origin}/list?page=2`);
  expect(report.loadMore).toBeNull();
  // Only the 10 cards count as content: header, aside "popular posts", footer and pagination links do not.
  expect(report.contentLinks).toBe(10);

  await open(page, `${demo.origin}/list?page=5`);
  const last = await analyze(page);
  expect(last.next).toMatchObject({ disabled: true, evidence: ['text "Next →"'] });
  expect(await page.evaluate(locators => window.__vestigium.query({ kind: 'control-state', locators, shadowHosts: [] }),
    report.next!.capture.locators)).toEqual({ state: 'missing' });
});

test('load more, infinite scroll and SPA lists are recognised', async ({ page, demo }) => {
  await open(page, `${demo.origin}/list?mode=more`);
  let report = await analyze(page);
  expect(report.next).toBeNull();
  expect(report.loadMore).toMatchObject({ disabled: false, evidence: ['text "Load more"'] });

  await open(page, `${demo.origin}/list?mode=infinite`);
  report = await analyze(page);
  expect(report.next).toBeNull();
  expect(report.loadMore).toBeNull(); // the infinite list hides its button
  expect(report.scrollable).toBe(true);
  const probe = await page.evaluate(() => window.__vestigium.query({ kind: 'scroll-probe', waitMs: 3000 }));
  expect(probe.before).toBe(10);
  expect(probe.after).toBeGreaterThan(10);

  await open(page, `${demo.origin}/list?mode=spa`);
  report = await analyze(page);
  expect(report.next).toMatchObject({ disabled: false, evidence: ['text "Next ›"'] });
  expect(report.numbered.pages).toEqual([]);
});

test('signatures change with the content and ignore site chrome', async ({ page, demo }) => {
  await open(page, `${demo.origin}/list`);
  const first = await page.evaluate(() => window.__vestigium.query({ kind: 'signature' }));
  expect(first.links).toHaveLength(10);
  expect(first.links[0]).toBe(`${demo.origin}/item/1`);
  await open(page, `${demo.origin}/list?page=2`);
  const second = await page.evaluate(() => window.__vestigium.query({ kind: 'signature' }));
  expect(second.hash).not.toBe(first.hash);
  await open(page, `${demo.origin}/list?page=1`);
  expect((await page.evaluate(() => window.__vestigium.query({ kind: 'signature' }))).hash).toBe(first.hash);
});
