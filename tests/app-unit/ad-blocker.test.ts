import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AdBlocker, type AdBlockerOptions, type RequestDetails } from '../../src/main/browser/ad-blocker.js';
import { FILTER_LISTS } from '../../src/main/browser/filter-lists.js';
import { Logger } from '../../src/main/logger.js';

// Ad blocking: which requests are blocked, where the filters come from (bundle, cache, refresh), and that a bad
// refresh never weakens what is already loaded.

const LIST = [
  '! A tiny list in EasyList syntax',
  '||ads.test^',
  '||tracker.test/ga.js$script,redirect=noopjs',
  '/banner-ad/*$image',
  '@@||ads.test/allowed.js',
  '##.ad-slot', // cosmetic: must be ignored (nothing is injected into pages)
].join('\n');

function fixture(list = LIST, fetchedAt = '2026-10-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-'));
  const bundled = join(directory, 'bundled');
  mkdirSync(bundled);
  writeFileSync(join(bundled, 'manifest.json'), JSON.stringify({ schemaVersion: 1, fetchedAt }));
  writeFileSync(join(bundled, 'easylist.txt'), list);
  const log = new Logger(join(directory, 'logs'));
  const make = (options: Partial<AdBlockerOptions> = {}) =>
    new AdBlocker({ bundledDir: bundled, cacheDir: join(directory, 'cache'), log, enabled: true, fetch: null, ...options });
  return {
    directory, bundled, log, make,
    close() {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) throw new Error('Refusing cleanup outside the temporary directory.');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const page = 'https://site.test/gallery/1';
const request = (url: string, extra: Partial<RequestDetails> = {}): RequestDetails =>
  ({ url, resourceType: 'script', webContentsId: 7, referrer: page, topUrl: page, ...extra });

test('blocks third-party ad requests from tab pages and leaves everything else alone', async () => {
  const f = fixture();
  try {
    const blocker = f.make();
    await blocker.load();
    assert.equal(blocker.status().filters, 4, 'network filters only; the cosmetic rule is not loaded');
    assert.deepEqual(blocker.decide(request('https://ads.test/serve.js')), { cancel: true });
    assert.deepEqual(blocker.decide(request('https://cdn.ads.test/x.js', { resourceType: 'subFrame' })), { cancel: true });
    assert.deepEqual(blocker.decide(request('https://cdn.site.test/banner-ad/top.png', { resourceType: 'image' })), { cancel: true });
    // Scripts some pages call (analytics) get a harmless stub instead of an error.
    const stub = blocker.decide(request('https://tracker.test/ga.js'));
    assert.ok(stub && 'redirectURL' in stub && stub.redirectURL.startsWith('data:'), 'redirected to a data: stub');

    assert.equal(blocker.decide(request('https://site.test/app.js')), null, 'the site itself');
    assert.equal(blocker.decide(request('https://ads.test/allowed.js')), null, 'exception rule');
    assert.equal(blocker.decide(request('https://ads.test/file.zip', { webContentsId: undefined })), null, 'the download queue (no tab)');
    assert.equal(blocker.decide(request('https://ads.test/', { resourceType: 'mainFrame' })), null, 'a page the person opens');
    // The frame may be gone: the referrer stands in for the page.
    assert.deepEqual(blocker.decide(request('https://ads.test/serve.js', { topUrl: null })), { cancel: true });
    assert.equal(blocker.status().blocked, 5);

    blocker.setEnabled(false);
    assert.equal(blocker.decide(request('https://ads.test/serve.js')), null, 'turned off');
    assert.equal(blocker.blocksPopup('https://ads.test/popunder', page), false);
    blocker.setEnabled(true);
    assert.equal(blocker.blocksPopup('https://ads.test/popunder', page), true, 'a popunder');
    assert.equal(blocker.blocksPopup('https://files.test/download/1', page), false, 'a file host popup');
  } finally { f.close(); }
});

test('the bundle is parsed once and cached; a newer bundle replaces an older cache; a corrupt cache is ignored', async () => {
  const f = fixture();
  try {
    const first = f.make();
    await first.load();
    assert.match(f.log.recent().at(-1)!.message, /bundled lists from 2026-10-01/);
    const second = f.make();
    await second.load();
    assert.match(f.log.recent().at(-1)!.message, /^Ad blocking ready: 4 filters \(lists from 2026-10-01\)/, 'served from the cache');

    // An app update ships newer lists than the cached ones.
    writeFileSync(join(f.bundled, 'manifest.json'), JSON.stringify({ schemaVersion: 1, fetchedAt: '2026-10-20T00:00:00.000Z' }));
    writeFileSync(join(f.bundled, 'easylist.txt'), `${LIST}\n||more-ads.test^`);
    const third = f.make();
    await third.load();
    assert.equal(third.status().filters, 5);
    assert.equal(third.status().listsUpdated, '2026-10-20T00:00:00.000Z');

    writeFileSync(join(f.directory, 'cache', 'engine.bin'), 'not an engine');
    const fourth = f.make();
    await fourth.load();
    assert.equal(fourth.status().filters, 5, 'rebuilt from the bundle');
    assert.deepEqual(fourth.decide(request('https://more-ads.test/x.js')), { cancel: true });
  } finally { f.close(); }
});

test('without lists the blocker lets everything through and says so', async () => {
  const f = fixture();
  try {
    rmSync(join(f.bundled, 'manifest.json'));
    const blocker = f.make();
    await blocker.load();
    assert.equal(blocker.status().filters, 0);
    assert.equal(blocker.decide(request('https://ads.test/serve.js')), null);
    assert.match(f.log.recent().at(-1)!.message, /unavailable/);
  } finally { f.close(); }
});

test('refresh: only when the lists are a week old, and a failed or truncated download keeps the current filters', async () => {
  const f = fixture();
  try {
    let now = Date.parse('2026-10-05T00:00:00.000Z');
    let serve: (url: string) => { ok: boolean; status: number; text: string } = () => ({ ok: true, status: 200, text: `${LIST}\n||fresh-ads.test^` });
    const fetched: string[] = [];
    const blocker = f.make({ now: () => now, fetch: async url => { fetched.push(url); const r = serve(url); return { ok: r.ok, status: r.status, text: async () => r.text }; } });
    await blocker.load();

    assert.equal(await blocker.refresh(), false, 'four days old: not yet');
    assert.equal(fetched.length, 0);

    now = Date.parse('2026-10-09T00:00:00.000Z');
    assert.equal(await blocker.refresh(), true);
    assert.deepEqual(fetched, FILTER_LISTS.map(list => list.url), 'every subscription');
    assert.deepEqual(blocker.decide(request('https://fresh-ads.test/x.js')), { cancel: true });
    assert.equal(blocker.status().listsUpdated, '2026-10-09T00:00:00.000Z');
    const cached = JSON.parse(readFileSync(join(f.directory, 'cache', 'engine.json'), 'utf8')) as { listsUpdated: string };
    assert.equal(cached.listsUpdated, '2026-10-09T00:00:00.000Z', 'the refreshed engine is cached for the next start');

    serve = url => url.includes('easyprivacy') ? { ok: false, status: 503, text: '' } : { ok: true, status: 200, text: LIST };
    assert.equal(await blocker.refresh(true), false);
    assert.match(f.log.recent().at(-1)!.message, /could not be updated \(HTTP 503\)/);
    assert.deepEqual(blocker.decide(request('https://fresh-ads.test/x.js')), { cancel: true }, 'still the previous lists');

    // An error page served with 200 parses to almost no filters.
    const before = blocker.status().filters;
    serve = () => ({ ok: true, status: 200, text: '<html>Rate limited</html>' });
    assert.equal(await blocker.refresh(true), false);
    assert.match(f.log.recent().at(-1)!.message, /only \d+ filters/);
    assert.equal(blocker.status().filters, before);
    assert.deepEqual(blocker.decide(request('https://fresh-ads.test/x.js')), { cancel: true });
  } finally { f.close(); }
});
