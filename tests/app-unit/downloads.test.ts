import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import { createDemoServer, type DemoServer } from '../demo-site/server.js';
import { generatedChunk, makeZip } from '../demo-site/downloads.js';
import { FILENAMES } from '../demo-site/fixtures.js';
import { chooseName, nameFromContentDisposition, sanitizeName, uniqueName, MAX_NAME_LENGTH } from '../../src/main/downloads/filename.js';
import { transfer, type Fetcher } from '../../src/main/downloads/transfer.js';
import { verifyFile } from '../../src/main/downloads/verify.js';
import { DownloadQueue, type EnqueueRequest, type QueueHooks } from '../../src/main/downloads/queue.js';
import { DownloadStore } from '../../src/main/downloads/store.js';
import { openDatabase } from '../../src/main/store/db.js';
import { Logger } from '../../src/main/logger.js';
import type { DownloadJob, DownloadSettings } from '../../src/shared/types.js';

// Milestone 6: file naming, resumable transfers, verification and the persistent queue, against the real demo server.

const LARGE = 300_000;
const fetcher: Fetcher = (url, init) => fetch(url, { headers: init.headers, signal: init.signal });

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-'));
  return {
    directory,
    close() {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) throw new Error('Refusing cleanup outside the temporary directory.');
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function withDemo<T>(run: (demo: DemoServer, directory: string) => Promise<T>, options = {}): Promise<T> {
  const place = scratch();
  const demo = await createDemoServer({ port: 0, hostPort: 0, largeBytes: LARGE, logDirectory: join(place.directory, 'demo-logs'), ...options });
  try {
    return await run(demo, place.directory);
  } finally {
    await demo.close();
    place.close();
  }
}

const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

// ---------- file names ----------

test('file names: Content-Disposition first (RFC 5987 wins), then the URL, then the page title', () => {
  const header = `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(FILENAMES.unicode)}`;
  assert.equal(nameFromContentDisposition(header), FILENAMES.unicode);
  assert.equal(nameFromContentDisposition('attachment; filename="a \\"quoted\\" name.zip"'), 'a "quoted" name.zip');
  assert.equal(nameFromContentDisposition('attachment; filename=plain.zip'), 'plain.zip');
  assert.equal(nameFromContentDisposition("attachment; filename*=iso-8859-1''caf%E9.zip"), 'café.zip');
  assert.equal(nameFromContentDisposition('inline'), null);
  const base = { url: 'http://example.test/files/report.pdf?x=1', title: 'A page', mimeType: 'application/pdf' };
  assert.equal(chooseName({ ...base, contentDisposition: header }), FILENAMES.unicode);
  assert.equal(chooseName({ ...base, contentDisposition: null }), 'report.pdf');
  assert.equal(chooseName({ ...base, url: 'http://example.test/download?id=4', contentDisposition: null }), 'A page.pdf');
  assert.equal(chooseName({ ...base, url: 'http://example.test/download', contentDisposition: null, suggested: 'chromium.zip' }), 'chromium.zip');
  assert.equal(chooseName({ url: 'http://example.test/', title: '', mimeType: null, contentDisposition: null }), 'download');
});

test('file names are safe on Windows: invalid characters, reserved names, trailing dots, bidi tricks, length', () => {
  assert.equal(sanitizeName(FILENAMES.invalid), 'CON_notes___draft____.zip');
  assert.equal(sanitizeName('CON.zip'), '_CON.zip');
  assert.equal(sanitizeName('lpt1.tar.gz'), '_lpt1.tar.gz');
  assert.equal(sanitizeName('notes. . '), 'notes');
  assert.equal(sanitizeName('...'), 'download');
  assert.equal(sanitizeName('a/b\\c.zip'), 'a_b_c.zip');
  const rlo = String.fromCharCode(0x202e);
  assert.equal(sanitizeName(`invoice${rlo}fdp.exe`), 'invoicefdp.exe');
  const long = sanitizeName(FILENAMES.long);
  assert.ok(long.length <= MAX_NAME_LENGTH && long.endsWith('.zip') && long.startsWith('Long title Long title'));
  // Never cuts a surrogate pair in half.
  const emoji = sanitizeName(`${'😀'.repeat(200)}.zip`);
  assert.ok(emoji.endsWith('.zip') && !/[\uD800-\uDBFF]\.zip$/.test(emoji));
  assert.equal(sanitizeName(FILENAMES.unicode), FILENAMES.unicode);
  const taken = new Set(['notes.zip', 'notes (2).zip']);
  assert.equal(uniqueName('notes.zip', name => taken.has(name)), 'notes (3).zip');
  assert.equal(uniqueName('fresh.zip', name => taken.has(name)), 'fresh.zip');
});

// ---------- transfers ----------

test('transfer: a whole file, then a resume with Range/If-Range that continues the .part exactly', () => withDemo(async (demo, directory) => {
  const zip = await makeZip();
  const part = join(directory, 'zip.part');
  const signal = new AbortController().signal;
  const whole = await transfer(fetcher, { url: `${demo.origin}/files/disposition`, referrer: null, partPath: part, validator: { etag: null, lastModified: null }, signal });
  assert.ok(whole.ok);
  assert.equal(whole.info.contentDisposition?.includes('field-notes.zip'), true);
  assert.deepEqual(readFileSync(part), zip);

  const large = join(directory, 'large.part');
  writeFileSync(large, generatedChunk(0, 100_000));
  const progress: number[] = [];
  const resumed = await transfer(fetcher, {
    url: `${demo.origin}/files/large`, referrer: null, partPath: large, validator: { etag: '"generated-v1-300000"', lastModified: null }, signal,
    onProgress: received => progress.push(received),
  });
  assert.ok(resumed.ok);
  assert.equal(resumed.restarted, false);
  assert.equal(resumed.info.resumed, true);
  assert.equal(resumed.info.offset, 100_000);
  assert.equal(resumed.info.totalBytes, LARGE);
  assert.ok(progress[0] > 100_000 && progress.at(-1) === LARGE);
  assert.deepEqual(readFileSync(large), generatedChunk(0, LARGE));
}));

test('transfer: no Range support, a changed file (If-Range), a complete part (416) and a bogus part all end correct', () => withDemo(async (demo, directory) => {
  const signal = new AbortController().signal;
  const expected = generatedChunk(0, LARGE);
  const fresh = (name: string, bytes: Buffer) => { const path = join(directory, name); writeFileSync(path, bytes); return path; };
  const get = (path: string, query = '', etag: string | null = null) =>
    transfer(fetcher, { url: `${demo.origin}/files/large${query}`, referrer: null, partPath: path, validator: { etag, lastModified: null }, signal });

  const noRange = fresh('norange.part', generatedChunk(0, 50_000));
  const plain = await get(noRange, '?range=off');
  assert.ok(plain.ok && plain.restarted);
  assert.deepEqual(readFileSync(noRange), expected);

  // The server's ETag differs from the one stored with the part: it sends the whole file (200), never a splice.
  const changed = fresh('changed.part', Buffer.alloc(50_000, 7));
  const replaced = await get(changed, '', '"generated-v0-old"');
  assert.ok(replaced.ok && replaced.restarted);
  assert.deepEqual(readFileSync(changed), expected);

  const complete = fresh('complete.part', expected);
  const done = await get(complete);
  assert.ok(done.ok && !done.restarted);
  assert.equal(done.receivedBytes, LARGE);

  const bogus = fresh('bogus.part', Buffer.concat([expected, Buffer.alloc(10)]));
  const fixed = await get(bogus);
  assert.ok(fixed.ok && fixed.restarted);
  assert.deepEqual(readFileSync(bogus), expected);
}));

test('transfer: dead links, expired links and error pages are classified, network drops are retryable and resumable', () => withDemo(async (demo, directory) => {
  const signal = new AbortController().signal;
  const part = join(directory, 'x.part');
  const get = (path: string) => transfer(fetcher, { url: `${demo.origin}${path}`, referrer: null, partPath: part, validator: { etag: null, lastModified: null }, signal });
  assert.deepEqual(await get('/files/dead'), { ok: false, kind: 'dead', message: 'The download link is dead (404 Not Found).', retryable: false, status: 404 });
  const expired = await get('/files/expiring?token=nope');
  assert.ok(!expired.ok && expired.kind === 'expired' && expired.status === 410 && !expired.retryable);
  const html = await get('/files/html');
  assert.ok(!html.ok && html.kind === 'html');

  // Stop mid-transfer (as pause or a crash would): the bytes so far stay in the part, and the next attempt continues.
  const controller = new AbortController();
  const slow = join(directory, 'slow.part');
  let seen = 0;
  const stopped = await transfer(fetcher, {
    url: `${demo.origin}/files/large?throttle=400000`, referrer: null, partPath: slow, validator: { etag: null, lastModified: null }, signal: controller.signal,
    onProgress: received => { seen = received; if (received > 60_000) controller.abort(); },
  });
  assert.ok(!stopped.ok && stopped.kind === 'aborted');
  const kept = readFileSync(slow).length;
  assert.ok(kept > 60_000 && kept < LARGE, `kept ${kept}, saw ${seen}`);
  const rest = await transfer(fetcher, { url: `${demo.origin}/files/large`, referrer: null, partPath: slow, validator: { etag: '"generated-v1-300000"', lastModified: null }, signal });
  assert.ok(rest.ok && rest.info.resumed && rest.info.offset === kept);
  assert.deepEqual(readFileSync(slow), generatedChunk(0, LARGE));

  const offline = await transfer(fetcher, { url: 'http://127.0.0.1:9/file.zip', referrer: null, partPath: part, validator: { etag: null, lastModified: null }, signal });
  assert.ok(!offline.ok && offline.kind === 'network' && offline.retryable);
}));

// ---------- verification ----------

async function zipOf(entries: { name: string; data: Buffer; compress: boolean }[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(entry.data, entry.name, { compress: entry.compress, mtime: new Date('2026-01-01T00:00:00Z') });
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  const finished = new Promise(resolve => zip.outputStream.on('end', resolve));
  zip.end();
  await finished;
  return Buffer.concat(chunks);
}

test('verify: ZIP entries are inflated and CRC-checked; damage, truncation, emptiness and disguised pages fail', async () => {
  const place = scratch();
  try {
    const write = (name: string, bytes: Buffer) => { const path = join(place.directory, name); writeFileSync(path, bytes); return path; };
    const data = Buffer.from('field notes '.repeat(5000));
    const archive = await zipOf([{ name: 'deflated.txt', data, compress: true }, { name: 'stored.bin', data: generatedChunk(0, 4096), compress: false }]);
    assert.deepEqual(await verifyFile(write('ok.zip', archive), { totalBytes: archive.length, name: 'ok.zip' }),
      { ok: true, kind: 'zip', note: 'ZIP test passed (2 entries).' });
    assert.deepEqual(await verifyFile(write('demo.zip', await makeZip()), { totalBytes: null, name: 'demo.zip' }),
      { ok: true, kind: 'zip', note: 'ZIP test passed (1 entry).' });

    // Flip one byte inside the stored entry: structure intact, checksum wrong.
    const damaged = Buffer.from(archive);
    const at = damaged.indexOf(generatedChunk(0, 64));
    damaged[at + 10] ^= 0xff;
    const broken = await verifyFile(write('damaged.zip', damaged), { totalBytes: null, name: 'damaged.zip' });
    assert.ok(!broken.ok && /stored\.bin": its checksum does not match/.test(broken.message), JSON.stringify(broken));

    const truncated = await verifyFile(write('cut.zip', archive.subarray(0, archive.length - 30)), { totalBytes: null, name: 'cut.zip' });
    assert.ok(!truncated.ok && /no end record/.test(truncated.message));
    assert.deepEqual(await verifyFile(write('empty.zip', Buffer.alloc(0)), { totalBytes: null, name: 'empty.zip' }), { ok: false, message: 'The downloaded file is empty.' });
    assert.deepEqual(await verifyFile(write('short.bin', Buffer.alloc(10)), { totalBytes: 20, name: 'short.bin' }),
      { ok: false, message: 'The file has 10 bytes, but the server announced 20.' });
    const page = await verifyFile(write('file.zip', Buffer.from('\n  <!DOCTYPE html><title>Error</title>')), { totalBytes: null, name: 'file.zip' });
    assert.ok(!page.ok && /web page/.test(page.message));
    assert.deepEqual(await verifyFile(write('a.rar', Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), Buffer.alloc(20)])), { totalBytes: null, name: 'a.rar' }),
      { ok: true, kind: 'rar', note: 'RAR signature found; the archive was not test-extracted.' });
  } finally {
    place.close();
  }
});

// ---------- the queue ----------

function queueFixture(directory: string, hooks: QueueHooks = {}, overrides: Partial<DownloadSettings> = {}) {
  const db = openDatabase(join(directory, 'store.sqlite'));
  const store = new DownloadStore(db);
  const log = new Logger(join(directory, 'logs'));
  const settings: DownloadSettings = { directory: join(directory, 'out'), concurrency: 2, retries: 1, force: false, template: '{site}/{filename}', sidecar: false, extract: 'off', ...overrides };
  const make = () => new DownloadQueue(store, () => settings, join(directory, 'unused'), fetcher, log, () => {}, { freeBytes: async () => 1e12, ...hooks });
  return { db, store, log, settings, make, messages: () => log.recent().map(entry => entry.message) };
}

const request = (demo: DemoServer, path: string, item: number | null, title = `Item ${item}`): EnqueueRequest => ({
  url: `${demo.origin}${path}`, referrer: `${demo.origin}/item/${item ?? 0}`, sourcePage: `${demo.origin}/item/${item ?? 0}`, title,
  suggestedName: null, mimeType: null, origin: null,
  item: item === null ? null : { url: `${demo.origin}/item/${item}`, title, sourcePage: `${demo.origin}/list` },
});

const settled = (store: DownloadStore, ids: string[]) => () =>
  ids.every(id => ['done', 'failed', 'cancelled', 'paused'].includes(store.jobs.get(id)!.status));

test('queue: files land verified and named; a dead link fails alone; identical bytes are stored once; done items are skipped', () => withDemo(async (demo, directory) => {
  // One at a time, so "the first copy" of the identical ZIPs is deterministic.
  const f = queueFixture(directory, {}, { concurrency: 1 });
  try {
    const queue = f.make();
    queue.start();
    const jobs = [
      queue.enqueue(request(demo, '/files/dead', 1))!,
      queue.enqueue(request(demo, '/files/large', 2))!,
      queue.enqueue(request(demo, '/files/disposition', 3))!,
      queue.enqueue(request(demo, `/files/unicode`, 4))!,
      queue.enqueue(request(demo, '/files/invalid', 5))!,
    ];
    await until(settled(f.store, jobs.map(job => job.id)));
    const [dead, large, zip, unicode, invalid] = jobs.map(job => f.store.jobs.get(job.id)!);
    assert.equal(dead.status, 'failed');
    assert.equal(dead.error, 'The download link is dead (404 Not Found).');
    assert.equal(f.store.itemByUrl(`${demo.origin}/item/1`)!.status, 'no_download');
    assert.equal(large.status, 'done');
    assert.equal(large.finalPath, join(f.settings.directory, '127.0.0.1', 'generated.bin'));
    assert.deepEqual(readFileSync(large.finalPath), generatedChunk(0, LARGE));
    assert.equal(zip.finalPath, join(f.settings.directory, '127.0.0.1', 'field-notes.zip'));
    // Same ZIP bytes under other names: recorded as duplicates of the first, not stored again.
    for (const copy of [unicode, invalid]) {
      assert.equal(copy.status, 'done');
      assert.equal(copy.duplicateOf, zip.id);
      assert.equal(copy.finalPath, zip.finalPath);
    }
    assert.equal(unicode.filename, FILENAMES.unicode);
    assert.equal(invalid.filename, 'CON_notes___draft____.zip');
    assert.deepEqual(readdirSync(join(f.settings.directory, '127.0.0.1')).sort(), ['field-notes.zip', 'generated.bin']);
    assert.deepEqual(readdirSync(join(f.settings.directory, '.vestigium-parts')), []);
    assert.equal(f.store.itemByUrl(`${demo.origin}/item/3`)!.status, 'done');
    assert.ok(f.messages().some(message => message.startsWith('Downloaded "field-notes.zip" (') && message.endsWith('ZIP test passed (1 entry).')));
    assert.ok(f.messages().includes('Download queue finished: 4 downloaded, 1 failed.'));

    // Item 3 is done: it is skipped (a run would not even open it); Force downloads it again.
    assert.equal(queue.isItemDone(`${demo.origin}/item/3`), true);
    assert.equal(queue.enqueue(request(demo, '/files/disposition', 3)), null);
    f.settings.force = true;
    assert.equal(queue.isItemDone(`${demo.origin}/item/3`), false);
    const again = queue.enqueue(request(demo, '/files/disposition', 3))!;
    await until(settled(f.store, [again.id]));
    assert.equal(f.store.jobs.get(again.id)!.finalPath, join(f.settings.directory, '127.0.0.1', 'field-notes (2).zip'));
    queue.dispose();
  } finally {
    f.db.close();
  }
}));

test('queue: a killed app resumes its partial file on the next start; pause, resume, cancel and retry work', () => withDemo(async (demo, directory) => {
  const f = queueFixture(directory);
  try {
    // "Crash": the first queue is abandoned mid-transfer. Its process would be gone; here its transfer is aborted and
    // the job is left exactly as a killed app leaves it: status "running", bytes in the part.
    const first = f.make();
    first.start();
    const job = first.enqueue(request(demo, '/files/large?throttle=300000', 7))!;
    await until(() => existsSync(job.tempPath) && readFileSync(job.tempPath).length > 80_000);
    first.dispose();
    f.store.jobs.save({ ...f.store.jobs.get(job.id)!, status: 'running' });
    const partial = readFileSync(job.tempPath).length;
    assert.ok(partial > 80_000 && partial < LARGE);

    const second = f.make();
    second.start();
    assert.ok(f.messages().includes('Resuming the download queue: 1 download (1 interrupted by the last shutdown).'));
    await until(settled(f.store, [job.id]));
    const finished = f.store.jobs.get(job.id)!;
    assert.equal(finished.status, 'done', finished.error ?? '');
    assert.deepEqual(readFileSync(finished.finalPath), generatedChunk(0, LARGE));
    assert.ok(f.messages().some(message => /^Resuming "generated\.bin" at \d+\.\d KB of 293\.0 KB\.$/.test(message)), f.messages().join('\n'));

    // Pause keeps the part; resume continues it; cancel removes it; retry brings a failed job back.
    const slow = second.enqueue(request(demo, '/files/large?throttle=200000', 8))!;
    await until(() => existsSync(slow.tempPath) && readFileSync(slow.tempPath).length > 20_000);
    second.pause(slow.id);
    await until(() => f.store.jobs.get(slow.id)!.status === 'paused');
    const kept = readFileSync(slow.tempPath).length;
    assert.ok(kept > 20_000);
    second.cancel(slow.id);
    assert.equal(f.store.jobs.get(slow.id)!.status, 'cancelled');
    await until(() => !existsSync(slow.tempPath));

    const dead = second.enqueue(request(demo, '/files/dead', 9))!;
    await until(settled(f.store, [dead.id]));
    second.retry(dead.id);
    assert.ok(['queued', 'running'].includes(f.store.jobs.get(dead.id)!.status));
    await until(settled(f.store, [dead.id]));
    assert.equal(f.store.jobs.get(dead.id)!.attempts, 1);

    // "Pause all" holds new downloads until "Resume all".
    second.pause(null);
    const held = second.enqueue(request(demo, '/files/disposition', 10))!;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.store.jobs.get(held.id)!.status, 'queued');
    assert.equal(second.state().held, true);
    second.resume(null);
    await until(settled(f.store, [held.id]));
    assert.equal(f.store.jobs.get(held.id)!.status, 'done');
    second.dispose();
  } finally {
    f.db.close();
  }
}));

test('queue: low disk space pauses instead of failing; an expired link is renewed and the part continues', () => withDemo(async (demo, directory) => {
  let free = 1000;
  // The renewal hook reopens the item page and reads its fresh link, like redoing the recorded step would.
  const renew = async (_job: DownloadJob) => {
    const page = await (await fetch(`${demo.origin}/item/1?variant=expiring`)).text();
    const href = /href="([^"]*\/files\/expiring[^"]*)"/.exec(page)![1].replaceAll('&amp;', '&');
    return new URL(href, demo.origin).href;
  };
  const f = queueFixture(directory, { freeBytes: async () => free, resolve: renew });
  try {
    const queue = f.make();
    queue.start();
    const tight = queue.enqueue(request(demo, '/files/disposition', 1))!;
    await until(settled(f.store, [tight.id]));
    const paused = f.store.jobs.get(tight.id)!;
    assert.equal(paused.status, 'paused');
    assert.match(paused.error!, /^Not enough free disk space in .+: 1000 bytes free, 64\.0 MB needed\. Free some space, then resume\.$/);
    free = 1e12;
    queue.resume(tight.id);
    await until(() => f.store.jobs.get(tight.id)!.status === 'done');

    // A token that is no longer valid (410): the page is reopened for a fresh link, and the download finishes.
    const expired = queue.enqueue(request(demo, '/files/expiring?token=stale', 2))!;
    await until(settled(f.store, [expired.id]));
    const renewed = f.store.jobs.get(expired.id)!;
    assert.equal(renewed.status, 'done', renewed.error ?? '');
    assert.match(renewed.url, /token=[0-9a-f-]{36}/);
    assert.ok(f.messages().some(message => message.includes('Reopening the page it came from to get a fresh link.')));
    queue.dispose();
  } finally {
    f.db.close();
  }
}));
