import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import { ARCHIVES, archiveBytes, PHOTO_LIST } from '../demo-site/downloads.js';
import { PASSWORD, ZIP_TEXT } from '../demo-site/fixtures.js';
import { extractArchive, findSevenZip, safeSegments } from '../../src/main/downloads/archive.js';

// Milestone 7: unpacking. The encrypted fixtures were made by 7-Zip, an independent encoder, so these tests check the
// ZipCrypto and WinZip AES decryption against real archives rather than against our own encoder.

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

const unpack = async (directory: string, name: string, bytes: Buffer, password: string | null, sevenZip: string | null = null, maxBytes = 1e9) => {
  const archive = join(directory, name);
  writeFileSync(archive, bytes);
  return extractArchive(archive, { password, destination: join(directory, `${name}-out`), sevenZip, maxBytes });
};

async function zipOf(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(entry.data, entry.name, { mtime: new Date('2026-01-01T00:00:00Z') });
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  const finished = new Promise(done => zip.outputStream.on('end', done));
  zip.end();
  await finished;
  return Buffer.concat(chunks);
}

test('ZipCrypto and AES-256 archives made by 7-Zip unpack with the password, byte for byte', async () => {
  const place = scratch();
  try {
    for (const kind of ['encrypted', 'aes'] as const) {
      const result = await unpack(place.directory, ARCHIVES[kind].name, archiveBytes(kind), PASSWORD);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.files, 2);
      assert.deepEqual(result.skipped, []);
      assert.equal(readFileSync(join(result.folder, 'notes', 'readme.txt'), 'utf8'), ZIP_TEXT);
      assert.equal(readFileSync(join(result.folder, 'notes', 'photo-list.txt'), 'utf8'), PHOTO_LIST);
      assert.equal(existsSync(`${result.folder}.vestigium-unpacking`), false);
    }
  } finally {
    place.close();
  }
});

test('a wrong or missing password is reported as such and leaves nothing behind', async () => {
  const place = scratch();
  try {
    for (const kind of ['encrypted', 'aes'] as const) {
      const wrong = await unpack(place.directory, `wrong-${ARCHIVES[kind].name}`, archiveBytes(kind), 'not-the-password');
      assert.deepEqual(wrong, { ok: false, reason: 'password', message: 'The password from the item page does not open the archive.' });
      const missing = await unpack(place.directory, `none-${ARCHIVES[kind].name}`, archiveBytes(kind), null);
      assert.deepEqual(missing, { ok: false, reason: 'password', message: 'The archive is password-protected, and the item page showed no password.' });
    }
    assert.deepEqual(readdirSync(place.directory).filter(name => name.endsWith('-out') || name.endsWith('.vestigium-unpacking')), []);
  } finally {
    place.close();
  }
});

test('zip-slip paths are skipped, names are made safe, and a bomb stops at its declared size', async () => {
  assert.equal(safeSegments('../evil.txt'), null);
  assert.equal(safeSegments('a/../../evil.txt'), null);
  assert.equal(safeSegments('C:/Windows/evil.txt'), null);
  assert.equal(safeSegments('/etc/passwd'), null);
  assert.deepEqual(safeSegments('notes//./CON.txt'), ['notes', '_CON.txt']);
  assert.deepEqual(safeSegments('a\\b:c.txt'), ['a', 'b_c.txt']);
  const place = scratch();
  try {
    // yazl refuses ".." itself; write "xx/evil.txt" and patch the name in both headers (names are not in the CRC).
    const slip = await zipOf([{ name: 'xx/evil.txt', data: Buffer.from('evil') }, { name: 'good.txt', data: Buffer.from('good') }]);
    const patched = Buffer.from(slip.toString('latin1').replaceAll('xx/evil.txt', '../evil.txt'), 'latin1');
    const result = await unpack(place.directory, 'slip.zip', patched, null);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.skipped, ['../evil.txt (unsafe path)']);
    assert.equal(existsSync(join(place.directory, 'evil.txt')), false);
    assert.equal(readFileSync(join(result.folder, 'good.txt'), 'utf8'), 'good');

    // A "bomb": the directory says 10 bytes, the data inflates to 100 000.
    const big = await zipOf([{ name: 'bomb.txt', data: Buffer.alloc(100_000, 65) }]);
    const bomb = Buffer.from(big);
    const central = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(10, central + 24);
    const exploded = await unpack(place.directory, 'bomb.zip', bomb, null);
    assert.deepEqual(exploded, { ok: false, reason: 'damaged', message: '"bomb.txt" is larger than the archive says.' });

    const tooBig = await unpack(place.directory, 'space.zip', big, null, null, 50_000);
    assert.ok(!tooBig.ok && tooBig.reason === 'space');
  } finally {
    place.close();
  }
});

const sevenZip = findSevenZip();
test('7z archives unpack through 7-Zip when it is installed (password checked), and are kept as they are otherwise', async context => {
  const place = scratch();
  try {
    const without = await unpack(place.directory, 'keep.7z', archiveBytes('sevenzip'), PASSWORD, null);
    assert.deepEqual(without, { ok: false, reason: 'unsupported', message: 'Install 7-Zip to unpack 7Z archives; the archive was kept as it is.' });
    if (!sevenZip) {
      context.skip('7-Zip is not installed on this machine.');
      return;
    }
    const result = await unpack(place.directory, ARCHIVES.sevenzip.name, archiveBytes('sevenzip'), PASSWORD, sevenZip);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.files, 2);
    assert.equal(readFileSync(join(result.folder, 'notes', 'readme.txt'), 'utf8'), ZIP_TEXT);
    const wrong = await unpack(place.directory, `wrong-${ARCHIVES.sevenzip.name}`, archiveBytes('sevenzip'), 'nope', sevenZip);
    assert.deepEqual(wrong, { ok: false, reason: 'password', message: 'The password from the item page does not open the archive.' });
  } finally {
    place.close();
  }
});
