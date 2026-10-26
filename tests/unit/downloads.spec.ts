import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import yauzl from 'yauzl';
import { test, expect } from '../support.js';
import { FILENAMES, ZIP_TEXT } from '../demo-site/fixtures.js';
import { createDemoServer } from '../demo-site/server.js';
import { createLogger } from '../demo-site/logger.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function expectedBytes(size: number, offset = 0) { return Buffer.from(Array.from({ length: size }, (_, index) => (index + offset) % 251)); }
async function zipContents(buffer: Buffer) {
  return new Promise<Record<string, string>>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const contents: Record<string, string> = {};
      zip.on('error', reject); zip.on('end', () => resolve(contents));
      zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error); return; }
        const chunks: Buffer[] = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { contents[entry.fileName] = Buffer.concat(chunks).toString(); zip.readEntry(); });
      })); zip.readEntry();
    });
  });
}
test('ZIP opens and contains the documented file', async ({ demo, request }) => {
  const response = await request.get(`${demo.origin}/files/disposition`);
  expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('application/zip');
  const bytes = await response.body(); expect(bytes.length).toBe(Number(response.headers()['content-length']));
  expect(await zipContents(bytes)).toEqual({ 'readme.txt': ZIP_TEXT });
});
test('default large file streams 64 MiB with correct byte hash', async ({ demo }) => {
  const response = await fetch(`${demo.origin}/files/large`);
  expect(Number(response.headers.get('content-length'))).toBe(64 * 1024 * 1024);
  const actual = createHash('sha256'), expected = createHash('sha256'); let received = 0;
  for await (const chunk of response.body!) { actual.update(chunk); received += chunk.length; }
  const pattern = expectedBytes(251 * 1024);
  for (let offset = 0; offset < received; offset += pattern.length) expected.update(pattern.subarray(0, Math.min(pattern.length, received - offset)));
  expect(received).toBe(64 * 1024 * 1024); expect(actual.digest('hex')).toBe(expected.digest('hex'));
});
test.describe('small generated download fixtures', () => {
  test.use({ demoOptions: { largeBytes: 128 * 1024 } });
  test('Range suffix, bounded, open-ended, invalid and If-Range handling', async ({ demo, request }) => {
    for (const [range, start, end] of [['bytes=10-99', 10, 99], ['bytes=131000-', 131000, 131071], ['bytes=-50', 131022, 131071]] as const) {
      const response = await request.get(`${demo.origin}/files/large`, { headers: { Range: range } });
      expect(response.status()).toBe(206); expect(response.headers()['content-range']).toBe(`bytes ${start}-${end}/131072`);
      expect(await response.body()).toEqual(expectedBytes(end - start + 1, start));
    }
    for (const range of ['bytes=131072-', 'bytes=90-10', 'bytes=-0', 'bytes=0-10,20-30', 'invalid']) {
      const response = await request.get(`${demo.origin}/files/large`, { headers: { Range: range } });
      expect(response.status()).toBe(416); expect(response.headers()['content-range']).toBe('bytes */131072');
    }
    const stale = await request.get(`${demo.origin}/files/large`, { headers: { Range: 'bytes=50-', 'If-Range': '"stale"' } });
    expect(stale.status()).toBe(200); expect((await stale.body()).length).toBe(131072);
    const head = await request.head(`${demo.origin}/files/large`); expect(head.headers()['content-length']).toBe('131072'); expect((await head.body()).length).toBe(0);
  });
  test('Range off returns full 200 body', async ({ demo, request }) => {
    const response = await request.get(`${demo.origin}/files/large?range=off`, { headers: { Range: 'bytes=100-' } });
    expect(response.status()).toBe(200); expect(response.headers()['content-range']).toBeUndefined();
    expect(await response.body()).toEqual(expectedBytes(131072));
  });
  test('throttled transfer can be interrupted and resumed without corrupting bytes', async ({ demo, request }) => {
    const controller = new AbortController(); const started = performance.now();
    const response = await fetch(`${demo.origin}/files/large?throttle=65536`, { signal: controller.signal });
    const reader = response.body!.getReader(); const chunks: Buffer[] = []; let received = 0;
    while (received < 20000) { const { value, done } = await reader.read(); if (done) throw new Error('Transfer ended before interruption.'); chunks.push(Buffer.from(value)); received += value.length; }
    expect(performance.now() - started).toBeGreaterThanOrEqual(250); expect(received).toBeLessThan(131072);
    controller.abort(); await reader.cancel().catch(() => {});
    const resumed = await request.get(`${demo.origin}/files/large`, { headers: { Range: `bytes=${received}-` } });
    expect(resumed.status()).toBe(206);
    const combined = Buffer.concat([...chunks, await resumed.body()]);
    expect(combined.length).toBe(131072); expect(hash(combined)).toBe(hash(expectedBytes(131072)));
    expect((await request.get(`${demo.origin}/health`)).status()).toBe(200);
  });
});
test('server-wide throttle and Range configuration apply', async ({}, info) => {
  const demo = await createDemoServer({ port: 0, hostPort: 0, largeBytes: 8192, throttleBytesPerSecond: 8192, rangeEnabled: false, logDirectory: info.outputPath('custom-logs') });
  try { const start = performance.now(); const response = await fetch(`${demo.origin}/files/large`, { headers: { Range: 'bytes=1-' } });
    expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBe(8192); expect(performance.now() - start).toBeGreaterThan(850);
  } finally { await demo.close(); }
});
test('dead links, HTML error responses and missing countdown tickets fail clearly', async ({ demo, request }) => {
  const dead = await request.get(`${demo.origin}/files/dead`); expect(dead.status()).toBe(404); expect(await dead.text()).toContain('no longer available');
  const html = await request.get(`${demo.origin}/files/html`); expect(html.status()).toBe(200); expect(html.headers()['content-type']).toContain('text/html'); expect(await html.text()).toContain('File host error');
  expect((await request.get(`${demo.hostOrigin}/files/countdown`)).status()).toBe(403);
});
test.describe('expiring download token', () => {
  test.use({ demoOptions: { tokenLifetimeMs: 100 } });
  test('link expires and item reload renews it', async ({ demo, request }) => {
    const link = async () => {
      const html = await (await request.get(`${demo.origin}/item/1?variant=expiring`)).text();
      return new URL(/href="([^"]*\/files\/expiring[^"]*)"/.exec(html)![1].replaceAll('&amp;', '&'), demo.origin).href;
    };
    const first = await link(); expect((await request.get(first)).status()).toBe(200);
    await delay(130); const expired = await request.get(first); expect(expired.status()).toBe(410); expect(await expired.text()).toContain('Reload the item page');
    const second = await link(); expect(second).not.toBe(first); expect((await request.get(second)).status()).toBe(200);
  });
});
test('filename headers, URL-only and absent filename variants', async ({ demo, request }) => {
  for (const [kind, filename] of Object.entries(FILENAMES)) {
    const response = await request.get(`${demo.origin}/files/${kind}`);
    const encoded = response.headers()['content-disposition'].split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe(filename);
    expect(await zipContents(await response.body())).toEqual({ 'readme.txt': ZIP_TEXT });
  }
  for (const path of ['/files/url/url-only.zip', '/files/none']) {
    const response = await request.get(demo.origin + path); expect(response.status()).toBe(200);
    expect(response.headers()['content-disposition']).toBeUndefined(); expect(response.headers()['content-type']).toContain('application/zip');
  }
});
test('protected downloads count, assets and health do not; redirects stay local', async ({ demo, request }) => {
  const login = await request.post(`${demo.origin}/login`, { form: { username: 'demo', password: 'vestigium', returnTo: '//example.com' }, maxRedirects: 0 });
  expect(login.headers().location).toBe('/list?login=1'); expect(login.headers()['set-cookie']).toContain('HttpOnly');
  for (let i = 0; i < 6; i++) { expect((await request.get(`${demo.origin}/health`)).status()).toBe(200); expect((await request.get(`${demo.origin}/assets/style.css`)).status()).toBe(200); }
  for (let i = 0; i < 5; i++) expect((await request.get(`${demo.origin}/files/disposition?login=1`, { maxRedirects: 0 })).status()).toBe(200);
  const expired = await request.get(`${demo.origin}/files/disposition?login=1`, { maxRedirects: 0 }); expect(expired.status()).toBe(302); expect(expired.headers().location).toContain('/login?returnTo=');
});
test('independent servers isolate state and seed reproducible mutations', async ({ demo }, info) => {
  const other = await createDemoServer({ port: 0, hostPort: 0, logDirectory: info.outputPath('other-logs') });
  try {
    const first = await (await fetch(`${demo.origin}/item/1?mutate=all`)).text();
    const second = await (await fetch(`${other.origin}/item/1?mutate=all`)).text();
    expect(first.match(/action-[a-f0-9]+/)?.[0]).toBe(second.match(/action-[a-f0-9]+/)?.[0]);
    await fetch(`${demo.origin}/list?dataset=changing`); await fetch(`${demo.origin}/list?dataset=changing`);
    const fresh = await (await fetch(`${other.origin}/list?dataset=changing`)).text(); expect(fresh.indexOf('data-item-id="1"')).toBeLessThan(fresh.indexOf('data-item-id="10"'));
    const login = await fetch(`${demo.origin}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=vestigium', redirect: 'manual' });
    const rejected = await fetch(`${other.origin}/list?login=1`, { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }, redirect: 'manual' }); expect(rejected.status).toBe(302);
  } finally { await other.close(); await other.close(); }
});
test('global login configuration protects pages with custom request limit', async ({}, info) => {
  const demo = await createDemoServer({ port: 0, hostPort: 0, loginRequired: true, sessionRequests: 1, logDirectory: info.outputPath('login-logs') });
  try {
    expect((await fetch(`${demo.origin}/item/1`, { redirect: 'manual' })).status).toBe(302);
    const response = await fetch(`${demo.origin}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=vestigium', redirect: 'manual' });
    const headers = { cookie: response.headers.get('set-cookie')!.split(';')[0] };
    expect((await fetch(`${demo.origin}/item/1`, { headers, redirect: 'manual' })).status).toBe(200);
    expect((await fetch(`${demo.origin}/item/1`, { headers, redirect: 'manual' })).status).toBe(302);
  } finally { await demo.close(); }
});
test('rotating log retains levels, reasons and three backups', async ({}, info) => {
  const directory = info.outputPath('rotation'); const log = createLogger(directory, 100);
  for (let i = 0; i < 12; i++) log(i % 2 ? 'error' : 'info', `Readable event ${i}: download unavailable.`);
  expect((await readdir(directory)).sort()).toEqual(['demo.log', 'demo.log.1', 'demo.log.2', 'demo.log.3']);
  const record = JSON.parse((await readFile(join(directory, 'demo.log'), 'utf8')).trim());
  expect(record.level).toBe('error'); expect(record.message).toContain('download unavailable');
});
