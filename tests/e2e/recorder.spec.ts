import { buildSync } from 'esbuild';
import type { Frame, Page } from '@playwright/test';
import { test, expect } from '../support.js';
import type { ElementCapture, PageEvent, RecorderCommand } from '../../src/shared/recorder.js';
import type {} from './recorder-harness.js';

// The production recorder core, bundled with a stub transport, injected into every frame (main and cross-origin).
const harness = buildSync({
  entryPoints: ['tests/e2e/recorder-harness.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
}).outputFiles[0].text;

type Captured = { frame: string; event: PageEvent };
type Targeted = Extract<PageEvent, { target: unknown }>;

async function setup(page: Page) {
  const events: Captured[] = [];
  await page.exposeBinding('__vestigiumSend', (source, event: PageEvent) => {
    events.push({ frame: source.frame.url(), event });
  });
  await page.addInitScript({ content: harness });
  return events;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  const banner = page.getByRole('button', { name: 'Accept cookies' });
  if (await banner.isVisible()) await banner.click();
}

async function armAll(page: Page, armed = true) {
  for (const frame of page.frames()) await frame.evaluate(value => window.__vestigium.arm(value), armed);
}

const kinds = (events: Captured[]) => events.map(captured => captured.event.kind);
const targetOf = (captured: Captured) => (captured.event as Targeted).target as ElementCapture;
const locator = (target: ElementCapture, strategy: string) => target.locators.find(item => item.strategy === strategy)?.value;
const command = (target: ElementCapture, action: RecorderCommand['action']): RecorderCommand =>
  ({ locators: target.locators, shadowHosts: target.shadowHosts, action, highlight: true, heal: false });
const run = (frame: Page | Frame, value: RecorderCommand) => frame.evaluate(input => window.__vestigium.run(input), value);

test('a list click records ranked role, text, css, xpath and fingerprint locators that each re-find the link', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/list`);
  await armAll(page);
  await page.getByRole('link', { name: 'Field Notes 01', exact: true }).click();
  await expect(page).toHaveURL(`${demo.origin}/item/1`);
  await expect.poll(() => kinds(events)).toEqual(['click']);
  const target = targetOf(events[0]);
  expect(target.description).toEqual({ tag: 'a', role: 'link', name: 'Field Notes 01' });
  expect(target.shadowHosts).toEqual([]);
  expect(locator(target, 'role')).toBe('link "Field Notes 01"');
  expect(locator(target, 'text')).toBe('a "Field Notes 01"');
  expect(locator(target, 'xpath')).toMatch(/^\/html\[1\]\/body\[1\]\/.+\/a\[1\]$/);
  expect(target.locators.map(item => item.strategy)).toEqual(expect.arrayContaining(['role', 'text', 'css', 'xpath', 'fingerprint']));
  const confidences = target.locators.map(item => item.confidence);
  expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  // Fixture-only test hooks must never become locators.
  expect(JSON.stringify(target.locators)).not.toContain('data-item-id');
  await open(page, `${demo.origin}/list`);
  for (const single of target.locators) {
    expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: [single], shadowHosts: [] }), single.strategy)
      .toContain('href="/item/1"');
  }
});

test('typing coalesces into one input event before Enter; select and password fields are handled', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await armAll(page);
  const search = page.getByRole('textbox', { name: 'Search notes' });
  await search.click();
  await page.keyboard.type('notes', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${demo.origin}/lab?q=notes`);
  await expect.poll(() => kinds(events)).toEqual(['click', 'input', 'key']);
  const input = events[1].event as Extract<PageEvent, { kind: 'input' }>;
  expect(input.value).toBe('notes');
  expect(input.target.description).toEqual({ tag: 'input', role: 'textbox', name: 'Search notes' });
  expect(locator(input.target, 'testid')).toBe('input[name="q"]');
  expect((events[2].event as Extract<PageEvent, { kind: 'key' }>).key).toBe('Enter');

  // New document after the submit: arm again, as main will do for every frame that reports ready.
  events.length = 0;
  await armAll(page);
  // Keyboard changes on a focused <select> produce trusted change events (Playwright's selectOption would not).
  await page.getByRole('combobox', { name: 'Tag' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => kinds(events)).toEqual(['select', 'select']);
  const select = events[1].event as Extract<PageEvent, { kind: 'select' }>;
  expect([select.value, select.label]).toEqual(['architecture', 'Architecture']);
  expect(select.target.description).toEqual({ tag: 'select', role: 'combobox', name: 'Tag' });

  const secret = 'hunter2-never-recorded';
  await page.getByLabel('Archive password').click();
  await page.keyboard.type(secret);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  // One content-free notice per field; nothing about the field or its value leaves the page.
  await expect.poll(() => kinds(events)).toEqual(['select', 'select', 'sensitive']);
  expect(events[2].event).toEqual({ kind: 'sensitive' });
  expect(JSON.stringify(events)).not.toContain('hunter2');
  expect(JSON.stringify(events)).not.toContain('Archive password');
});

test('shadow DOM targets record their host path and replay through it', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await armAll(page);
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await expect.poll(() => kinds(events)).toEqual(['click']);
  const target = targetOf(events[0]);
  expect(target.shadowHosts).toEqual(['lab-widget']);
  expect(locator(target, 'role')).toBe('button "Shadow action"');
  expect(locator(target, 'testid')).toBe('#shadow-action');
  await expect(page.getByText('Shadow clicked 1')).toBeVisible();
  // Each locator works inside the shadow root; none would work from the document root.
  for (const single of target.locators) {
    expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: [single], shadowHosts: ['lab-widget'] }), single.strategy)
      .toContain('id="shadow-action"');
  }
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: target.locators, shadowHosts: [] }))
    .toMatchObject({ status: 'not-found' });
  await page.evaluate(() => window.__vestigium.arm(false));
  expect(await run(page, command(target, { kind: 'click' }))).toMatchObject({ status: 'done', strategy: 'testid' });
  await expect(page.getByText('Shadow clicked 2')).toBeVisible();
  expect(await run(page, { ...command(target, { kind: 'click' }), shadowHosts: ['missing-host'] }))
    .toEqual({ status: 'not-found', message: 'Shadow host 1 (missing-host) was not found.' });
});

test('same-origin and cross-origin iframes record and replay inside their own frame', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await armAll(page);
  await page.frameLocator('iframe[title="Same-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
  await page.frameLocator('iframe[title="Cross-origin frame"]').getByRole('button', { name: 'Frame action' }).click();
  await expect.poll(() => kinds(events)).toEqual(['click', 'click']);
  expect(events[0].frame).toBe(`${demo.origin}/lab/frame?label=Same-origin`);
  expect(events[1].frame).toBe(`${demo.hostOrigin}/lab/frame?label=Cross-origin`);
  for (const captured of events) {
    const target = targetOf(captured);
    expect(locator(target, 'role')).toBe('button "Frame action"');
    const frame = page.frames().find(candidate => candidate.url() === captured.frame)!;
    expect(await run(frame, command(target, { kind: 'click' }))).toMatchObject({ status: 'done' });
    await expect(frame.locator('#frame-status')).toHaveText('Frame clicked 2');
  }
});

test('user scrolls are recorded per container after settling; page-initiated scrolls are not', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await page.waitForTimeout(1100); // let the cookie click's scroll intent expire
  await armAll(page);
  const box = page.getByRole('region', { name: 'Scroll area' });
  // Programmatic scrolling with no preceding user input is ignored.
  await box.evaluate(element => { element.scrollTop = 300; });
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(700);
  expect(kinds(events)).toEqual([]);

  await box.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => kinds(events)).toEqual(['scroll']);
  const scroll = events[0].event as Extract<PageEvent, { kind: 'scroll' }>;
  expect(scroll.target?.description).toEqual({ tag: 'div', role: 'region', name: 'Scroll area' });
  expect(scroll.y).toBe(await box.evaluate(element => Math.round(element.scrollTop)));
  expect(scroll.y).toBeGreaterThan(300);

  // A click right after scrolling flushes the pending scroll first, preserving order.
  await page.getByRole('heading', { name: 'Recorder lab' }).hover();
  await page.mouse.wheel(0, 150);
  await page.getByRole('link', { name: 'View two' }).click();
  await expect.poll(() => kinds(events)).toEqual(['scroll', 'scroll', 'click']);
  expect(events[1].event).toMatchObject({ kind: 'scroll', target: null });
  expect(locator(targetOf(events[2]), 'role')).toBe('link "View two"');

  // Replay: window and container scrolls.
  await page.evaluate(() => window.__vestigium.arm(false));
  expect(await run(page, { locators: [], shadowHosts: [], action: { kind: 'scroll', x: 0, y: 0 }, highlight: false, heal: false }))
    .toEqual({ status: 'done', strategy: 'window', value: 'window' });
  expect(await run(page, command(scroll.target!, { kind: 'scroll', x: 0, y: 1000 }))).toMatchObject({ status: 'done' });
  expect(await box.evaluate(element => element.scrollTop)).toBeGreaterThan(900);
});

test('scrolling caused by a click or by keys inside form controls is not a user scroll', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await page.waitForTimeout(1100);
  await armAll(page);
  // A click, then the page scrolls itself (as a page reacting to the click, or an automation tool, would).
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await page.evaluate(() => window.scrollTo(0, 500));
  // Arrow keys in a <select> change the option; the page then scrolls by script.
  await page.getByRole('combobox', { name: 'Tag' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.scrollTo(0, 100));
  await page.waitForTimeout(700);
  expect(kinds(events)).toEqual(['click', 'select']);
  // Scroll keys outside form controls do scroll, and are recorded. (The heading click is recorded too:
  // sites attach handlers to plain elements, so non-interactive clicks are kept.)
  await page.getByRole('heading', { name: 'Recorder lab' }).click();
  await page.keyboard.press('PageDown');
  await expect.poll(() => kinds(events)).toEqual(['click', 'select', 'click', 'scroll']);
});

test('synthetic page events and disarmed input are never recorded', async ({ page, demo }) => {
  const events = await setup(page);
  await open(page, `${demo.origin}/lab`);
  await page.getByRole('button', { name: 'Shadow action' }).click(); // not armed yet
  await armAll(page);
  await page.evaluate(() => {
    const button = document.querySelector('lab-widget')!.shadowRoot!.querySelector('button')!;
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const field = document.querySelector<HTMLInputElement>('input[name="q"]')!;
    field.value = 'fake';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await armAll(page, false);
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await page.waitForTimeout(300);
  expect(events).toEqual([]);
  await armAll(page);
  await page.getByRole('button', { name: 'Shadow action' }).click();
  await expect.poll(() => kinds(events)).toEqual(['click']);
});

test('replay actions: type with Enter submits, select by value, disabled and missing targets are reported', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/lab`);
  const search = await page.evaluate(() => window.__vestigium.describe('input[name="q"]'));
  const tag = await page.evaluate(() => window.__vestigium.describe('#tag'));
  expect(await run(page, command(tag!, { kind: 'select', value: 'portrait', label: 'Portrait' }))).toMatchObject({ status: 'done' });
  await expect(page.locator('#tag-status')).toHaveText('Tag filter: portrait');
  // A renumbered option value falls back to its label.
  expect(await run(page, command(tag!, { kind: 'select', value: 'gone', label: 'Landscape' }))).toMatchObject({ status: 'done' });
  await expect(page.locator('#tag-status')).toHaveText('Tag filter: landscape');
  expect(await run(page, command(tag!, { kind: 'select', value: 'x', label: 'Nope' })))
    .toEqual({ status: 'error', message: 'Action failed: option "Nope" no longer exists' });
  expect(await run(page, command(search!, { kind: 'type', value: 'replayed', key: 'Enter' }))).toMatchObject({ status: 'done' });
  await expect(page).toHaveURL(`${demo.origin}/lab?q=replayed`);
  await expect(page.locator('#search-status')).toHaveText('Results for "replayed"');

  expect(await run(page, { locators: [{ strategy: 'role', value: 'button "Nope"', confidence: 0.9 }], shadowHosts: [], action: { kind: 'click' }, highlight: false, heal: false }))
    .toEqual({ status: 'not-found', message: 'No recorded locator matched exactly one element.' });
  // An ambiguous high-confidence locator is skipped in favor of a unique lower-confidence one, never guessed.
  expect(await run(page, { locators: [{ strategy: 'css', value: 'a', confidence: 0.99 }, { strategy: 'role', value: 'link "View one"', confidence: 0.5 }], shadowHosts: [], action: { kind: 'none' }, highlight: false, heal: false }))
    // The best-ranked locator failed, so the result carries locators rebuilt from the element actually used.
    .toMatchObject({ status: 'done', strategy: 'role', value: 'link "View one"', refreshed: expect.arrayContaining([{ strategy: 'role', value: 'link "View one"', confidence: 0.9 }]) });

  await open(page, `${demo.origin}/list?page=5`);
  const next = await page.evaluate(() => window.__vestigium.describe('.pagination button'));
  expect(await run(page, command(next!, { kind: 'click' }))).toMatchObject({ status: 'not-ready', message: expect.stringContaining('disabled') });
});

test('position-based locators never redirect a step to a different item when a list shifts', async ({ page, demo }) => {
  await setup(page);
  // First request: items 1-10 on page 1. Every later request: item 20 first, so the 10th card is item 9.
  await open(page, `${demo.origin}/list?dataset=changing`);
  const target = (await page.evaluate(() => window.__vestigium.describe('#items article:nth-of-type(10) h3 a')))!;
  expect(locator(target, 'role')).toBe('link "Field Notes 10"');
  await page.reload();
  await expect(page.locator('#items article').first()).toContainText('Field Notes 20');
  const positional = target.locators.filter(item => item.strategy === 'css' || item.strategy === 'xpath');
  expect(positional.length).toBeGreaterThan(0);
  // Each positional locator alone still points at "the 10th card" — which is now a different item.
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: positional.slice(0, 1), shadowHosts: [] }))
    .toContain('href="/item/9"');
  // With the recorded identity alongside, that match is refused instead of clicked.
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: target.locators, shadowHosts: [] })).toEqual({
    status: 'not-found',
    message: 'No recorded locator matched exactly one element. A position-based match was rejected: it is link "Field Notes 09", not the recorded link "Field Notes 10".',
  });
});

test('ranked fallbacks still find a download link after classes, wrappers and order change', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/item/1`);
  const target = (await page.evaluate(() => window.__vestigium.describe('.original-action a')))!;
  expect(locator(target, 'css')).toBe('a.download-action');
  expect(locator(target, 'role')).toBe('link "Download ZIP"');
  await open(page, `${demo.origin}/item/1?mutate=all`);
  const cssOnly = target.locators.filter(item => item.strategy === 'css');
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: cssOnly, shadowHosts: [] })).toMatchObject({ status: 'not-found' });
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: target.locators, shadowHosts: [] })).toContain('Download ZIP');
});

test('self-healing finds a slightly renamed button, refreshes locators, and explains itself', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/item/1`);
  const target = (await page.evaluate(() => window.__vestigium.describe('.original-action a')))!;
  await open(page, `${demo.origin}/item/1?mutate=label`);
  // The class-based CSS locator still matches (the class did not change): a fallback, reported with fresh locators.
  const fallback = await run(page, command(target, { kind: 'none' }));
  expect(fallback).toMatchObject({ status: 'done', strategy: 'css', value: 'a.download-action', refreshed: expect.any(Array) });
  // Without that locator, role, text and fingerprint all carry the old name: only healing finds the button.
  const named = { ...target, locators: target.locators.filter(item => item.strategy !== 'css') };
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: named.locators, shadowHosts: [] }))
    .toMatchObject({ status: 'not-found' });
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: named.locators, shadowHosts: [], heal: true }))
    .toContain('Download ZIP file');
  const result = await run(page, { ...command(named, { kind: 'none' }), heal: true });
  expect(result).toMatchObject({
    status: 'done', strategy: 'healed', value: 'link "Download ZIP file"',
    healed: expect.stringMatching(/^No recorded locator matched; healed to link "Download ZIP file" \(recorded as "Download ZIP", \d+% similar\)\.$/),
  });
  // The refreshed locators describe the element as it is now.
  expect((result as { refreshed: { strategy: string; value: string }[] }).refreshed).toContainEqual(expect.objectContaining({ strategy: 'role', value: 'link "Download ZIP file"' }));
});

test('healing never jumps to a different numbered item, even when the name is otherwise similar', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/list?dataset=changing`);
  const target = (await page.evaluate(() => window.__vestigium.describe('#items article:nth-of-type(10) h3 a')))!;
  await page.reload(); // item 10 is now on page 2; items 20 and 1–9 are here
  expect(await page.evaluate(input => window.__vestigium.resolved(input), { locators: target.locators, shadowHosts: [], heal: true }))
    .toMatchObject({ status: 'not-found' });
});

test('a consent banner covering the target is dismissed first; other overlays make the step wait', async ({ page, demo }) => {
  await setup(page);
  await page.goto(`${demo.origin}/lab`); // banner not accepted
  await expect(page.getByRole('dialog', { name: 'Cookie preferences' })).toBeVisible();
  const target = (await page.evaluate(() => window.__vestigium.describe('#shadow-action', 'lab-widget')))!;
  expect(await run(page, command(target, { kind: 'click' }))).toMatchObject({ status: 'done', banner: 'Accept cookies' });
  await expect(page.getByRole('dialog', { name: 'Cookie preferences' })).toBeHidden();
  await expect(page.getByText('Shadow clicked 1')).toBeVisible();

  // A non-consent overlay is never clicked away: the step reports what covers the target and waits.
  await page.evaluate(() => {
    const blocker = document.createElement('div');
    blocker.id = 'blocker';
    blocker.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:10';
    document.body.append(blocker);
  });
  const bottom = (await page.evaluate(() => window.__vestigium.describe('#bottom-action')))!;
  expect(await run(page, command(bottom, { kind: 'click' }))).toEqual({ status: 'not-ready', message: 'The target is covered by <div#blocker>.' });
  await expect(page.locator('#scroll-status')).toHaveText('Bottom action not used');
});

test('locate waits for a moving target to settle and reports where it ended up', async ({ page, demo }) => {
  await setup(page);
  await open(page, `${demo.origin}/lab`);
  const target = (await page.evaluate(() => window.__vestigium.describe('#trusted-action')))!;
  // The button is still moving (a script shifts it every 50 ms for ~600 ms) when the command arrives;
  // a click at its first position would miss.
  await page.locator('#trusted-action').evaluate(element => {
    const button = element as HTMLElement;
    let steps = 0;
    const timer = setInterval(() => {
      button.style.marginLeft = `${++steps * 15}px`;
      if (steps === 12) clearInterval(timer);
    }, 50);
  });
  const result = await run(page, command(target, { kind: 'locate' }));
  expect(await page.locator('#trusted-action').evaluate(element => (element as HTMLElement).style.marginLeft)).toBe('180px');
  const actual = await page.locator('#trusted-action').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  expect(result).toMatchObject({ status: 'done', point: actual });
  // locate never clicks.
  await expect(page.locator('#trusted-status')).toHaveText('Trusted action not used');
});
