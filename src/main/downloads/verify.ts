import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { chunks, dataStart, isDirectory, isEncrypted, readAt, zipEntries, type ZipEntry } from './zip.js';

// Checks a finished file before it is kept (plan §5): not empty, the expected size, not a web page in disguise, and
// for ZIP archives a full test: every entry is inflated and its CRC-32 compared, streamed so size does not matter.
// RAR and 7z are recognized by signature only (testing them needs 7-Zip; extraction uses it when installed).
// Encrypted ZIP entries are checked for structure here; extraction with the item's password checks their contents.

export type ArchiveKind = 'zip' | 'rar' | '7z' | 'file';
export type Verification =
  | { ok: true; kind: ArchiveKind; note: string | null }
  | { ok: false; message: string };

const CHUNK = 1 << 20;

export function kindOf(head: Buffer): ArchiveKind {
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip'; // empty archive
  if (head.subarray(0, 6).equals(Buffer.from('Rar!\x1a\x07', 'latin1'))) return 'rar';
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  return 'file';
}

function looksLikeHtml(head: Buffer): boolean {
  const text = head.subarray(0, 512).toString('latin1').replace(/^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  return text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<head') || text.startsWith('<body');
}

// Streams the entry's data through inflate (or as stored) and compares the CRC-32 and size of what comes out.
async function checkEntry(file: FileHandle, entry: ZipEntry, fileSize: number): Promise<string | null> {
  const start = await dataStart(file, entry, fileSize);
  if (typeof start === 'string') return start;
  let crc = 0;
  let produced = 0;
  const consume = (chunk: Buffer) => {
    crc = crc32(chunk, crc);
    produced += chunk.length;
  };
  const inflate = entry.method === 8 ? createInflateRaw() : null;
  const finished = inflate ? new Promise<void>((resolve, reject) => {
    inflate.on('data', consume);
    inflate.on('end', resolve);
    inflate.on('error', reject);
  }) : null;
  try {
    for await (const chunk of chunks(file, start, entry.compressedSize, CHUNK)) {
      if (inflate) {
        if (!inflate.write(chunk)) await new Promise(resolve => inflate.once('drain', resolve));
      } else consume(chunk);
    }
    if (inflate) {
      inflate.end();
      await finished;
    }
  } catch (error) {
    return `"${entry.name}": its data does not decompress (${error instanceof Error ? error.message : 'inflate failed'}).`;
  }
  if (produced !== entry.size) return `"${entry.name}": expected ${entry.size} bytes, got ${produced}.`;
  if ((crc >>> 0) !== (entry.crc >>> 0)) return `"${entry.name}": its checksum does not match (the data is damaged).`;
  return null;
}

async function testZip(file: FileHandle, size: number): Promise<Verification> {
  const list = await zipEntries(file, size);
  if (typeof list === 'string') return { ok: false, message: list };
  let encrypted = 0;
  let unsupported = 0;
  for (const entry of list) {
    if (isDirectory(entry) && entry.size === 0) continue;
    if (isEncrypted(entry)) {
      encrypted++;
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      unsupported++;
      continue;
    }
    const problem = await checkEntry(file, entry, size);
    if (problem) return { ok: false, message: `The ZIP archive is damaged: ${problem}` };
  }
  const notes = [
    encrypted ? `${encrypted} encrypted entr${encrypted === 1 ? 'y' : 'ies'} checked for structure only` : '',
    unsupported ? `${unsupported} entr${unsupported === 1 ? 'y uses' : 'ies use'} a compression method checked for structure only` : '',
  ].filter(Boolean);
  return { ok: true, kind: 'zip', note: `ZIP test passed (${list.length} entr${list.length === 1 ? 'y' : 'ies'})${notes.length ? `; ${notes.join('; ')}` : ''}.` };
}

export async function verifyFile(path: string, expected: { totalBytes: number | null; name: string }): Promise<Verification> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return { ok: false, message: 'The downloaded file is empty.' };
    if (expected.totalBytes !== null && size !== expected.totalBytes) {
      return { ok: false, message: `The file has ${size} bytes, but the server announced ${expected.totalBytes}.` };
    }
    const head = await readAt(file, 0, 512);
    const kind = kindOf(head);
    if (kind === 'file' && !/\.(x?html?|xml|svg)$/i.test(expected.name) && looksLikeHtml(head)) {
      return { ok: false, message: 'The file is a web page, not the expected download (probably a host error page).' };
    }
    if (kind === 'zip') return await testZip(file, size);
    if (kind === 'rar' || kind === '7z') return { ok: true, kind, note: `${kind.toUpperCase()} signature found; the archive was not test-extracted.` };
    return { ok: true, kind, note: null };
  } finally {
    await file.close();
  }
}

export function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: CHUNK, signal });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
