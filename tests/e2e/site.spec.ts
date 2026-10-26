import { test, expect } from '../support.js';
import { BASE_IDS, CHANGING_CRAWL_IDS, DUPLICATE_IDS, PASSWORD, SCENARIOS } from '../demo-site/fixtures.js';
import type { Page } from '@playwright/test';

async function accept(page: Page) { await page.getByRole('button', { name: 'Accept cookies' }).click(); }
async function ids(page: Page) { return page.locator('#items [data-item-id]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-item-id')))); }
async function crawl(page: Page) {
  const result: number[] = []; let pages = 0;
  while (true) {
    result.push(...await ids(page)); pages++;
    if (!(await page.getByRole('link', { name: 'Next →', exact: true }).count())) break;
    if (pages > 10) throw new Error('Pagination did not terminate.');
    await page.getByRole('link', { name: 'Next →', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Next →' })).toBeDisabled();
  return { result, pages };
}
test('index links every scenario; cookie overlay blocks interaction and persists dismissal', async ({ page, demo }) => {
  await page.goto(demo.origin);
  await expect(page.locator('.scenarios a')).toHaveCount(SCENARIOS.length);
  await expect(page.getByRole('dialog', { name: 'Cookie preferences' })).toBeVisible();
  const target = page.getByRole('link', { name: 'Card pagination', exact: true });
  await expect(target.click({ trial: true, timeout: 400 })).rejects.toThrow();
  await accept(page); await target.click();
  await expect(page.getByRole('dialog')).toBeHidden(); await page.reload();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('aside article')).toHaveCount(3);
  await expect(page.locator('header a')).toHaveCount(4);
  await expect(page.locator('footer a')).toHaveCount(2);
  await expect(page.locator('#items article')).toHaveCount(10);
});
for (const layout of ['cards', 'table']) {
  test(`47 items across five pages in ${layout} layout`, async ({ page, demo }) => {
    await page.goto(`${demo.origin}/list?layout=${layout}`); await accept(page);
    await expect(page.locator(layout === 'table' ? '#items tr' : '#items article')).toHaveCount(10);
    expect(await crawl(page)).toEqual({ result: BASE_IDS, pages: 5 });
    await expect(page.locator('#items [data-item-id]')).toHaveCount(7);
    await page.screenshot({ path: test.info().outputPath(`${layout}-last-page.png`), fullPage: true });
  });
}
for (const layout of ['cards', 'table']) for (const mode of ['more', 'infinite']) {
  test(`${mode} / ${layout} reaches 47 and stops`, async ({ page, demo }) => {
    await page.goto(`${demo.origin}/list?mode=${mode}&layout=${layout}`); await accept(page);
    for (const count of [20, 30, 40, 47]) {
      if (mode === 'more') await page.getByRole('button', { name: 'Load more' }).click();
      else { await page.evaluate(() => scrollTo(0, 0)); await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); }
      await expect(page.locator('#items [data-item-id]')).toHaveCount(count);
    }
    expect(await ids(page)).toEqual(BASE_IDS);
    await expect(page.locator('#status')).toHaveText('End of collection');
    await expect(page.locator('#more')).toBeDisabled();
    await page.evaluate(() => dispatchEvent(new Event('scroll')));
    await expect(page.locator('#items [data-item-id]')).toHaveCount(47);
  });
}
for (const dataset of ['single', 'empty', 'duplicates', 'changing']) {
  test(`dataset: ${dataset}`, async ({ page, demo }) => {
    await page.goto(`${demo.origin}/list?dataset=${dataset}`); await accept(page);
    const result = await crawl(page);
    const expected = dataset === 'single' ? BASE_IDS.slice(0, 7) : dataset === 'empty' ? [] : dataset === 'duplicates' ? DUPLICATE_IDS : CHANGING_CRAWL_IDS;
    expect(result.result).toEqual(expected);
    if (dataset === 'empty') await expect(page.locator('#status')).toHaveText('No items found');
    if (dataset === 'duplicates') { expect(result.result.length).toBe(49); expect(new Set(result.result).size).toBe(47); }
    if (dataset === 'changing') { expect(result.result.filter(id => id === 10)).toHaveLength(2); expect(result.result).not.toContain(11); expect(result.result.at(-1)).toBe(48); }
  });
}
for (const mutation of ['classes', 'move', 'wrap', 'reorder', 'all']) {
  test(`download remains functional with ${mutation} mutation`, async ({ page, demo }) => {
    await page.goto(`${demo.origin}/item/1?mutate=${mutation}`); await accept(page);
    const button = page.getByRole('link', { name: 'Download ZIP', exact: true });
    const firstClass = await button.getAttribute('class');
    await page.reload();
    if (mutation === 'classes' || mutation === 'all') expect(await button.getAttribute('class')).not.toBe(firstClass);
    if (mutation === 'move' || mutation === 'all') await expect(page.locator('main > section.moved-action')).toHaveCount(1);
    if (mutation === 'wrap' || mutation === 'all') await expect(page.locator('section > div > section > div > a')).toHaveCount(1);
    if (mutation === 'reorder' || mutation === 'all') expect(await page.locator('main').evaluate(el => [...el.children].findIndex(e => e.tagName === 'DL') < [...el.children].findIndex(e => e.classList.contains('description')))).toBe(true);
    const downloadPromise = page.waitForEvent('download'); await button.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('field-notes.zip'); expect(await download.failure()).toBeNull();
  });
}
test('metadata exposes four password labels and one missing password', async ({ page, demo }) => {
  for (const [index, label] of ['Password:', 'Pass:', 'Unzip password:', 'Şifre:', null].entries()) {
    await page.goto(`${demo.origin}/item/${index + 1}`);
    if (index === 0) await accept(page);
    for (const name of ['Author', 'Tags', 'Date']) await expect(page.locator('dt').filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(1);
    if (label) { await expect(page.locator('dt').filter({ hasText: label })).toHaveCount(1); await expect(page.locator('dd').filter({ hasText: PASSWORD })).toHaveCount(1); }
    else { await expect(page.locator('dt')).toHaveCount(3); await expect(page.getByText(PASSWORD)).toHaveCount(0); }
  }
});
test('popup opens on the second origin and initiates a completed download', async ({ page, demo }) => {
  await page.goto(`${demo.origin}/item/1?variant=popup`); await accept(page);
  const downloaded = new Promise<import('@playwright/test').Download>(resolve => page.context().once('page', popup => popup.once('download', resolve)));
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Download ZIP', exact: true }).click();
  const popup = await popupPromise; await popup.waitForLoadState();
  expect(new URL(popup.url()).origin).toBe(demo.hostOrigin);
  const download = await downloaded; expect(await download.failure()).toBeNull();
});
test('countdown enforces five seconds on server and waits for manual Continue', async ({ page, demo, request }) => {
  await page.goto(`${demo.origin}/item/1?variant=countdown`); await accept(page);
  await page.getByRole('link', { name: 'Download ZIP', exact: true }).click();
  expect(new URL(page.url()).origin).toBe(demo.hostOrigin);
  // Storage is origin-specific, so the host has its own cookie banner.
  await accept(page);
  const button = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(button).toBeDisabled();
  const ticket = await page.locator('[name=ticket]').inputValue();
  const early = await request.get(`${demo.hostOrigin}/files/countdown?ticket=${ticket}`);
  expect(early.status()).toBe(425);
  let downloads = 0; page.on('download', () => downloads++);
  await expect(button).toBeEnabled({ timeout: 7000 }); expect(downloads).toBe(0);
  const pending = page.waitForEvent('download'); await button.click();
  expect(await (await pending).failure()).toBeNull();
});
test('login failure, success, HttpOnly cookie, expiry and continuation', async ({ page, demo, context }) => {
  await page.goto(`${demo.origin}/list?login=1`); await accept(page);
  await page.getByLabel('Username', { exact: true }).fill('demo');
  await page.getByLabel('Password', { exact: true }).fill('wrong'); await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Login failed' })).toBeVisible();
  await page.goto(`${demo.origin}/list?login=1`);
  await page.getByLabel('Username', { exact: true }).fill('demo'); await page.getByLabel('Password', { exact: true }).fill('vestigium');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${demo.origin}/list?login=1`);
  expect((await context.cookies()).find(cookie => cookie.name.startsWith('vestigium_'))?.httpOnly).toBe(true);
  for (let i = 0; i < 4; i++) { await page.reload(); await expect(page.getByRole('heading', { name: 'The field notes collection' })).toBeVisible(); }
  await page.goto(`${demo.origin}/item/3?login=1`); await expect(page.getByRole('heading', { name: 'Demo login' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('demo'); await page.getByLabel('Password', { exact: true }).fill('vestigium');
  await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page).toHaveURL(`${demo.origin}/item/3?login=1`);
});
