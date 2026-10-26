import { test, expect } from '../support.js';
import type { Page } from '@playwright/test';

async function openLab(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Accept cookies' }).click();
}

test('lab search submits with Enter and select updates its status', async ({ page, demo }) => {
  await openLab(page, `${demo.origin}/lab`);
  await expect(page.locator('#search-status')).toHaveText('No search yet.');
  await page.getByRole('textbox', { name: 'Search notes' }).fill('field <notes>');
  await page.getByRole('textbox', { name: 'Search notes' }).press('Enter');
  await expect(page).toHaveURL(/\/lab\?q=field\+%3Cnotes%3E$/);
  // The query is echoed escaped, never as markup.
  await expect(page.locator('#search-status')).toHaveText('Results for "field <notes>"');
  await page.getByRole('combobox', { name: 'Tag' }).selectOption({ label: 'Architecture' });
  await expect(page.locator('#tag-status')).toHaveText('Tag filter: architecture');
  await expect(page.getByLabel('Archive password')).toHaveAttribute('type', 'password');
});

test('lab open shadow root exposes a working button and link', async ({ page, demo }) => {
  await openLab(page, `${demo.origin}/lab`);
  // Playwright's role selectors pierce open shadow roots, just as the recorder must.
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await expect(page.getByText('Shadow clicked 2')).toBeVisible();
  const inShadow = await page.locator('lab-widget').evaluate(host => host.shadowRoot?.querySelector('#shadow-action') !== null);
  expect(inShadow).toBe(true);
  await page.getByRole('link', { name: 'Shadow link' }).click();
  await expect(page).toHaveURL(`${demo.origin}/item/2`);
});

test('lab same-origin and cross-origin frames are interactive and navigate the top page', async ({ page, demo }) => {
  await openLab(page, `${demo.origin}/lab`);
  const same = page.frameLocator('iframe[title="Same-origin frame"]');
  const cross = page.frameLocator('iframe[title="Cross-origin frame"]');
  await same.getByRole('button', { name: 'Frame action' }).click();
  await expect(same.locator('#frame-status')).toHaveText('Frame clicked 1');
  await cross.getByRole('button', { name: 'Frame action' }).click();
  await expect(cross.locator('#frame-status')).toHaveText('Frame clicked 1');
  const origins = page.frames().map(frame => new URL(frame.url()).origin);
  expect(origins).toEqual(expect.arrayContaining([demo.origin, demo.hostOrigin]));
  await cross.getByRole('link', { name: 'Frame item' }).click();
  await expect(page).toHaveURL(`${demo.origin}/item/3`);
});

test('lab SPA routes change URL and content without a document reload', async ({ page, demo }) => {
  await openLab(page, `${demo.origin}/lab`);
  // A marker on window survives pushState but not a real navigation.
  await page.evaluate(() => { (window as unknown as { marker: number }).marker = 7; });
  await page.getByRole('link', { name: 'View two' }).click();
  await expect(page).toHaveURL(`${demo.origin}/lab/spa/two`);
  await expect(page.locator('#spa-status')).toHaveText('SPA view: two');
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(7);
  await page.goBack();
  await expect(page.locator('#spa-status')).toHaveText('SPA view: home');
  // Deep links render server-side; unknown views are 404.
  await page.goto(`${demo.origin}/lab/spa/one`);
  await expect(page.locator('#spa-status')).toHaveText('SPA view: one');
  expect((await page.request.get(`${demo.origin}/lab/spa/three`)).status()).toBe(404);
});

test('lab scroll area hides its button until scrolled', async ({ page, demo }) => {
  await openLab(page, `${demo.origin}/lab`);
  const box = page.getByRole('region', { name: 'Scroll area' });
  const button = page.getByRole('button', { name: 'Bottom action' });
  const visibleInBox = () => box.evaluate(element => {
    const target = element.querySelector('#bottom-action')!.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return target.top >= frame.top && target.bottom <= frame.bottom;
  });
  expect(await visibleInBox()).toBe(false);
  await box.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await visibleInBox()).toBe(true);
  await button.click();
  await expect(page.locator('#scroll-status')).toHaveText('Bottom action used');
});
