import { buildSync } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from '../support.js';
import type { PageMetadata } from '../../src/shared/learn.js';
import { ITEMS, PASSWORD } from '../demo-site/fixtures.js';
import type {} from './recorder-harness.js';

// Metadata capture (src/recorder/learn/metadata.ts) through the production recorder core: the same facts written as
// a definition list, a table and inline "Label: value" lines are all found, with the password under every label
// the demo uses (Password, Pass, Unzip password, Turkish Şifre) and no password where the page shows none.

const harness = buildSync({
  entryPoints: ['tests/e2e/recorder-harness.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
}).outputFiles[0].text;

const LABELS = ['Password', 'Pass', 'Unzip password', 'Şifre', 'Author', 'Tags', 'Date', 'Model'];

async function read(page: Page, url: string, labels = LABELS): Promise<PageMetadata> {
  await page.goto(url);
  return page.evaluate(query => window.__vestigium.query(query), { kind: 'extract-metadata' as const, labels }) as Promise<PageMetadata>;
}

test.beforeEach(async ({ page }) => {
  await page.exposeBinding('__vestigiumSend', () => {});
  await page.addInitScript({ content: harness });
});

for (const style of ['list', 'table', 'inline']) {
  test(`item facts are read from a ${style} layout, with each password label`, async ({ page, demo }) => {
    for (const id of [1, 2, 3, 4, 5]) {
      const item = ITEMS[id - 1];
      const facts = await read(page, `${demo.origin}/item/${id}?meta=${style}`);
      expect(facts.title).toBe(item.title);
      const fields = Object.fromEntries(facts.fields.map(field => [field.label, field.value]));
      const expected: Record<string, string> = { Author: item.author, Tags: item.tag, Date: item.date };
      // The configured spelling is the key: the page's "Unzip password:" is stored as "Unzip password".
      if (item.passwordLabel) expected[item.passwordLabel.replace(/:$/, '')] = PASSWORD;
      expect(fields).toEqual(expected);
    }
  });
}

test('labels match case-insensitively; unlisted labels and hidden text are ignored', async ({ page, demo }) => {
  const facts = await read(page, `${demo.origin}/item/1`, ['password', 'AUTHOR']);
  expect(facts.fields).toEqual([{ label: 'AUTHOR', value: ITEMS[0].author }, { label: 'password', value: PASSWORD }]);
  await page.evaluate(() => {
    const hidden = document.createElement('p');
    hidden.hidden = true;
    hidden.textContent = 'Model: secret-hidden-model';
    document.body.append(hidden);
    const shown = document.createElement('p');
    shown.textContent = 'Model: VX-200';
    document.querySelector('main')!.append(shown);
  });
  const again = await page.evaluate(query => window.__vestigium.query(query), { kind: 'extract-metadata' as const, labels: ['Model'] }) as PageMetadata;
  expect(again.fields).toEqual([{ label: 'Model', value: 'VX-200' }]);
});
