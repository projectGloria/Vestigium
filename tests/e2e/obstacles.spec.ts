import { buildSync } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from '../support.js';
import type { Obstacles } from '../../src/shared/learn.js';
import type { PageEvent } from '../../src/shared/recorder.js';
import type {} from './recorder-harness.js';

// Human-in-the-loop detection (src/recorder/learn/obstacles.ts) through the production recorder core: what a run
// recognizes as needing a person, and that a captcha click is never recorded (plan §4: never solve or bypass).

const harness = buildSync({
  entryPoints: ['tests/e2e/recorder-harness.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
}).outputFiles[0].text;

// The demo's own cookie banner covers the page until accepted (it is not an obstacle a run waits for).
async function accept(page: Page) {
  const banner = page.getByRole('button', { name: 'Accept cookies' });
  if (await banner.isVisible()) await banner.click();
}

async function setup(page: Page) {
  const events: PageEvent[] = [];
  await page.exposeBinding('__vestigiumSend', (_source, event: PageEvent) => { events.push(event); });
  await page.addInitScript({ content: harness });
  return events;
}
const obstacles = (page: Page) => page.evaluate(() => window.__vestigium.query({ kind: 'obstacles' })) as Promise<Obstacles>;

test('a countdown, a captcha and a login form are recognized; an ordinary item page has none', async ({ page, demo }) => {
  await setup(page);
  await page.goto(`${demo.origin}/item/1`);
  expect(await obstacles(page)).toEqual({ captcha: null, login: false, countdown: null });

  await page.goto(`${demo.hostOrigin}/countdown`);
  expect((await obstacles(page)).countdown).toMatch(/^Wait \d seconds?/);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 10_000 });
  expect((await obstacles(page)).countdown).toBeNull();

  await page.goto(`${demo.hostOrigin}/captcha`);
  await accept(page);
  expect(await obstacles(page)).toEqual({ captcha: "a captcha (I'm not a robot)", login: false, countdown: null });
  await page.getByRole('checkbox', { name: "I'm not a robot" }).click();
  expect(await obstacles(page)).toEqual({ captcha: null, login: false, countdown: null });

  await page.goto(`${demo.origin}/login?returnTo=%2Fitem%2F1`);
  expect(await obstacles(page)).toEqual({ captcha: null, login: true, countdown: null });
});

test('clicking a captcha widget while recording records no click, only that a captcha was solved', async ({ page, demo }) => {
  const events = await setup(page);
  await page.goto(`${demo.hostOrigin}/captcha`);
  await accept(page);
  await page.evaluate(() => window.__vestigium.arm(true));
  await page.getByRole('checkbox', { name: "I'm not a robot" }).click();
  await page.getByRole('link', { name: 'Continue' }).evaluate(link => link.addEventListener('click', event => event.preventDefault()));
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect.poll(() => events.map(event => event.kind)).toEqual(['captcha', 'click']);
  const click = events[1] as Extract<PageEvent, { kind: 'click' }>;
  expect(click.target.description).toMatchObject({ role: 'link', name: 'Continue' });
});
