import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDemoServer } from '../demo-site/server.js';
import { PHOTO_LIST } from '../demo-site/downloads.js';
import { ITEMS, PASSWORD, ZIP_TEXT } from '../demo-site/fixtures.js';
import { applyTemplate, templateValues, tokenOf } from '../../src/main/downloads/filename.js';
import { sidecarName, sidecarText } from '../../src/main/downloads/sidecar.js';
import { DownloadQueue } from '../../src/main/downloads/queue.js';
import { DownloadStore } from '../../src/main/downloads/store.js';
import { findSevenZip } from '../../src/main/downloads/archive.js';
import { passwordOf, toItemMetadata } from '../../src/main/learn/metadata.js';
import { openDatabase } from '../../src/main/store/db.js';
import { Logger } from '../../src/main/logger.js';
import { templateSchema } from '../../src/main/validation.js';
import type { DownloadSettings } from '../../src/shared/types.js';

// Milestone 7: item details → metadata, filename templates, the _info.txt sidecar, and the queue unpacking a
// password-protected archive with the password captured from its item page.

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

test('page facts become item metadata; the password is found under any of its labels', () => {
  const metadata = toItemMetadata({
    url: 'http://example.test/item/4', title: 'Field Notes 04', tags: ['ignored, a labelled Tags wins'], date: '2026-10-04',
    fields: [{ label: 'Author', value: 'Author 4' }, { label: 'Tags', value: 'Portrait' }, { label: 'Şifre', value: PASSWORD }],
  });
  assert.deepEqual(metadata, { Title: 'Field Notes 04', Author: 'Author 4', Tags: 'Portrait', Şifre: PASSWORD, Date: '2026-10-04' });
  assert.equal(passwordOf(metadata), PASSWORD);
  for (const label of ['Password', 'pass', 'Unzip password', 'Mot de passe', 'Пароль']) assert.equal(passwordOf({ Author: 'x', [label]: 'p' }), 'p');
  assert.equal(passwordOf({ Author: 'x', Passage: 'not a password' }), null);
  assert.equal(toItemMetadata({ url: 'http://e.test/', title: 'T', tags: ['a', 'b'], date: null, fields: [] }).Tags, 'a, b');
});

test('templates place files by item details; values cannot add folders or change the file type', () => {
  const values = templateValues({
    site: '127.0.0.1', filename: 'field-notes.zip', title: 'page title',
    metadata: { Title: 'Field Notes 01', Tags: 'Landscape, Portrait', Author: 'Author 1', 'Unzip password': 'x', Date: '2026-10-01' },
  });
  assert.equal(values.tag, 'Landscape');
  assert.equal(values.unzip_password, 'x');
  assert.equal(tokenOf('Şifre'), 'sifre');
  assert.deepEqual(applyTemplate('{site}/{tag}/{title}.{ext}', values), { folders: ['127.0.0.1', 'Landscape'], name: 'Field Notes 01.zip' });
  assert.deepEqual(applyTemplate('{site}/{filename}', values), { folders: ['127.0.0.1'], name: 'field-notes.zip' });
  assert.deepEqual(applyTemplate('{author}/{date} {title}', values), { folders: ['Author 1'], name: '2026-10-01 Field Notes 01.zip' });
  // Missing values drop their folder; an empty file part falls back to the file's own name.
  assert.deepEqual(applyTemplate('{site}/{model}/{nothing}', values), { folders: ['127.0.0.1'], name: 'field-notes.zip' });
  // A title with slashes or a template that names another extension cannot escape or retype the file.
  const sneaky = templateValues({ site: 's', filename: 'a.zip', title: '', metadata: { Title: '../../evil/x' } });
  assert.deepEqual(applyTemplate('{title}', sneaky), { folders: [], name: '.._.._evil_x.zip' });
  assert.deepEqual(applyTemplate('{name}.exe', values), { folders: [], name: 'field-notes.exe.zip' });
  assert.equal(templateSchema.safeParse('{site}/../x').success, false);
  assert.equal(templateSchema.safeParse('C:/x/{title}').success, false);
  assert.equal(templateSchema.safeParse('/{title}').success, false);
  assert.equal(templateSchema.safeParse('{site}/{tag}/{title}.{ext}').success, true);
});

test('the sidecar lists the details, the password first, then where the file came from', () => {
  assert.equal(sidecarName('Field Notes 01.zip'), 'Field Notes 01_info.txt');
  const text = sidecarText({
    file: 'Field Notes 01.zip', folder: 'x', title: 'Field Notes 01', page: 'http://e.test/item/1', url: 'http://e.test/files/aes', bytes: 3148,
    sha256: 'ab'.repeat(32), savedAt: '2026-10-23T00:00:00.000Z', metadata: { Title: 'Field Notes 01', Author: 'Author 1', Password: PASSWORD },
    extractedTo: 'C:\\out\\Field Notes 01',
  });
  assert.ok(text.startsWith('\uFEFFTitle: Field Notes 01\r\nPassword: vestigium-demo\r\nAuthor: Author 1\r\n\r\nFile: Field Notes 01.zip\r\n'));
  assert.ok(text.includes('SHA-256: abab') && text.includes('Page: http://e.test/item/1') && text.includes('Unpacked to: C:\\out\\Field Notes 01'));
});

test('the queue places an AES archive by template, unpacks it with the item password, deletes it and writes the sidecar', async () => {
  const place = scratch();
  const demo = await createDemoServer({ port: 0, hostPort: 0, logDirectory: join(place.directory, 'demo-logs') });
  const db = openDatabase(join(place.directory, 'store.sqlite'));
  try {
    const store = new DownloadStore(db);
    const log = new Logger(join(place.directory, 'logs'));
    const out = join(place.directory, 'out');
    const settings: DownloadSettings = {
      directory: out, concurrency: 1, retries: 0, force: true, template: '{site}/{tag}/{title}.{ext}', sidecar: true, extract: 'delete',
    };
    const queue = new DownloadQueue(store, () => settings, out, (url, init) => fetch(url, { headers: init.headers, signal: init.signal }), log, () => {},
      { freeBytes: async () => 1e12, sevenZip: findSevenZip() });
    queue.start();
    const item = (id: number, password: string | null) => ({
      url: `${demo.origin}/item/${id}`, title: ITEMS[id - 1].title, sourcePage: `${demo.origin}/list`,
      metadata: { Title: ITEMS[id - 1].title, Author: ITEMS[id - 1].author, Tags: ITEMS[id - 1].tag, ...(password ? { 'Unzip password': password } : {}) },
    });
    const request = (path: string, id: number, password: string | null) => ({
      url: `${demo.origin}${path}`, referrer: `${demo.origin}/item/${id}`, sourcePage: `${demo.origin}/item/${id}`, title: ITEMS[id - 1].title,
      suggestedName: null, mimeType: null, origin: null, item: item(id, password),
    });
    const good = queue.enqueue(request('/files/aes', 1, PASSWORD))!;
    const wrong = queue.enqueue(request('/files/encrypted', 2, 'not-it'))!;
    const end = Date.now() + 15_000;
    while (![good, wrong].every(job => ['done', 'failed'].includes(store.jobs.get(job.id)!.status) && store.jobs.get(job.id)!.finishedAt)) {
      if (Date.now() > end) throw new Error('Timed out.');
      await new Promise(done => setTimeout(done, 25));
    }
    const unpacked = store.jobs.get(good.id)!;
    const folder = join(out, '127.0.0.1', 'Landscape');
    assert.equal(unpacked.status, 'done');
    assert.equal(unpacked.extractedTo, join(folder, 'Field Notes 01'));
    assert.equal(unpacked.finalPath, join(folder, 'Field Notes 01'));
    assert.match(unpacked.extractNote!, /^Unpacked 2 files into .+Field Notes 01\. The archive was deleted\.$/);
    assert.equal(readFileSync(join(folder, 'Field Notes 01', 'notes', 'readme.txt'), 'utf8'), ZIP_TEXT);
    assert.equal(readFileSync(join(folder, 'Field Notes 01', 'notes', 'photo-list.txt'), 'utf8'), PHOTO_LIST);
    assert.deepEqual(readdirSync(folder).sort(), ['Field Notes 01', 'Field Notes 01_info.txt']);
    const sidecar = readFileSync(join(folder, 'Field Notes 01_info.txt'), 'utf8');
    assert.ok(sidecar.includes(`Unzip password: ${PASSWORD}`) && sidecar.includes('Author: Author 1') && sidecar.includes('Unpacked to: '));
    assert.deepEqual(unpacked.details, ['Title', 'Author', 'Tags', 'Unzip password']);

    // The wrong password keeps the archive, says why, and still writes the sidecar; the download itself is done.
    const kept = store.jobs.get(wrong.id)!;
    assert.equal(kept.status, 'done');
    assert.equal(kept.extractNote, 'Not unpacked: The password from the item page does not open the archive.');
    assert.equal(kept.finalPath, join(out, '127.0.0.1', 'Architecture', 'Field Notes 02.zip'));
    assert.ok(existsSync(kept.finalPath) && existsSync(join(out, '127.0.0.1', 'Architecture', 'Field Notes 02_info.txt')));
    // Passwords never reach the log.
    assert.ok(!log.recent().some(entry => entry.message.includes(PASSWORD) || entry.message.includes('not-it')));
    queue.dispose();
  } finally {
    db.close();
    await demo.close();
    place.close();
  }
});
