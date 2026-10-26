import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { sanitizeName } from './filename.js';
import { kindOf } from './verify.js';
import {
  AesDecipher, aesSaltLength, chunks, dataStart, isDirectory, isEncrypted, readAt, zipCryptoCheck, ZipCryptoDecipher, zipEntries, type ZipEntry,
} from './zip.js';

// Unpacks a downloaded archive into a folder next to it (plan §5, "auto-extract using the captured password").
// ZIP is built in: stored and deflated entries, ZipCrypto and WinZip AES, each entry's CRC-32 or AES authentication
// code checked. 7z and RAR use 7-Zip when it is installed (spawned with an argument list, never a shell).
// Safety: entry paths with ".." or a drive/root are skipped (zip-slip), every path segment is sanitized for Windows,
// files are created exclusively, an entry may not inflate beyond its declared size (zip bombs), the declared total
// must fit the space allowed, and everything goes to a temporary folder that is renamed into place only on success.

export type ExtractResult =
  | { ok: true; folder: string; files: number; bytes: number; skipped: string[] }
  | { ok: false; reason: 'password' | 'damaged' | 'unsupported' | 'space'; message: string };

export interface ExtractOptions { password: string | null; destination: string; sevenZip: string | null; maxBytes: number }

class Refused extends Error {
  constructor(readonly reason: 'password' | 'damaged' | 'unsupported' | 'space', message: string) {
    super(message);
  }
}

// "a/b/../c" and "C:\x" are refused; ".", "" and duplicate separators are dropped.
export function safeSegments(name: string): string[] | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) return null;
  return segments.map(segment => sanitizeName(segment));
}

// 7-Zip in its usual places, or VESTIGIUM_7ZIP. Null when not installed: 7z/RAR archives are then kept as they are.
export function findSevenZip(): string | null {
  const candidates = [
    process.env.VESTIGIUM_7ZIP, process.env.ProgramFiles && join(process.env.ProgramFiles, '7-Zip', '7z.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe'), '/usr/bin/7z', '/usr/local/bin/7z',
  ];
  return candidates.find((path): path is string => Boolean(path) && existsSync(path!)) ?? null;
}

async function extractEntry(file: FileHandle, size: number, entry: ZipEntry, target: string, password: Buffer | null) {
  const start = await dataStart(file, entry, size);
  if (typeof start === 'string') throw new Refused('damaged', start);
  let from = start;
  let length = entry.compressedSize;
  let decrypt: ((chunk: Buffer) => Buffer) | null = null;
  let aes: AesDecipher | null = null;
  if (isEncrypted(entry)) {
    if (!password) throw new Refused('password', 'The archive is password-protected, and the item page showed no password.');
    if (entry.aes) {
      const saltLength = aesSaltLength(entry.aes.strength);
      const head = await readAt(file, start, saltLength + 2);
      aes = AesDecipher.open(password, entry.aes.strength, head.subarray(0, saltLength), head.subarray(saltLength));
      if (!aes) throw new Refused('password', 'The password from the item page does not open the archive.');
      from = start + saltLength + 2;
      length = entry.compressedSize - saltLength - 2 - 10;
      const cipher = aes;
      decrypt = chunk => cipher.decrypt(chunk);
    } else {
      const decipher = new ZipCryptoDecipher(password);
      const header = decipher.decrypt(await readAt(file, start, 12));
      if (header[11] !== zipCryptoCheck(entry)) throw new Refused('password', 'The password from the item page does not open the archive.');
      from = start + 12;
      length = entry.compressedSize - 12;
      decrypt = chunk => decipher.decrypt(chunk);
    }
  }
  const method = entry.aes ? entry.aes.method : entry.method;
  let produced = 0;
  let crc = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      produced += chunk.length;
      // A bomb announces a small size and inflates without end; stop at the declared size.
      if (produced > entry.size) return callback(new Refused('damaged', `"${entry.name}" is larger than the archive says.`));
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
  });
  async function* source() {
    for await (const chunk of chunks(file, from, Math.max(0, length))) yield decrypt ? decrypt(chunk) : chunk;
  }
  const stages: (Readable | Transform | Writable)[] = [Readable.from(source())];
  if (method === 8) stages.push(createInflateRaw());
  stages.push(meter, createWriteStream(target, { flags: 'wx' }));
  try {
    await (pipeline as (...streams: unknown[]) => Promise<void>)(...stages);
  } catch (error) {
    if (error instanceof Refused) throw error;
    // With ZipCrypto, a wrong password passes the one-byte check once in 256 and then produces garbage.
    throw new Refused(isEncrypted(entry) ? 'password' : 'damaged',
      `"${entry.name}" could not be unpacked${isEncrypted(entry) ? ' (damaged, or the password is wrong)' : ''}: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  if (produced !== entry.size) throw new Refused('damaged', `"${entry.name}": expected ${entry.size} bytes, got ${produced}.`);
  if (aes) {
    if (!aes.authentic(await readAt(file, start + entry.compressedSize - 10, 10))) {
      throw new Refused('damaged', `"${entry.name}" failed its authentication check (damaged, or the password is wrong).`);
    }
  }
  // AE-2 stores no CRC (the authentication code replaces it); everything else must match.
  if (!(entry.aes?.version === 2) && (crc >>> 0) !== (entry.crc >>> 0)) {
    throw new Refused(isEncrypted(entry) ? 'password' : 'damaged', `"${entry.name}": its checksum does not match${isEncrypted(entry) ? ' (the password is probably wrong)' : ''}.`);
  }
}

async function extractZip(path: string, into: string, password: string | null, maxBytes: number) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const list = await zipEntries(file, size);
    if (typeof list === 'string') throw new Refused('damaged', list);
    const declared = list.reduce((sum, entry) => sum + entry.size, 0);
    if (declared > maxBytes) throw new Refused('space', `Unpacking needs ${declared} bytes, more than the ${maxBytes} allowed by the free disk space.`);
    const secret = password === null ? null : Buffer.from(password, 'utf8');
    const skipped: string[] = [];
    const used = new Set<string>();
    let files = 0;
    for (const entry of list) {
      const segments = safeSegments(entry.name);
      if (!segments || segments.length === 0) {
        skipped.push(`${entry.name} (unsafe path)`);
        continue;
      }
      const target = join(into, ...segments);
      if (isDirectory(entry)) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const method = entry.aes ? entry.aes.method : entry.method;
      if (method !== 0 && method !== 8) {
        skipped.push(`${entry.name} (compression method ${method} is not supported)`);
        continue;
      }
      // Two names that sanitize to the same path (e.g. "a:b" and "a_b"): the second is skipped, never overwrites.
      if (used.has(target.toLowerCase())) {
        skipped.push(`${entry.name} (same name as another entry after making it safe for Windows)`);
        continue;
      }
      used.add(target.toLowerCase());
      await mkdir(join(into, ...segments.slice(0, -1)), { recursive: true });
      await extractEntry(file, size, entry, target, secret);
      files++;
    }
    return { files, bytes: declared, skipped };
  } finally {
    await file.close();
  }
}

function runSevenZip(executable: string, archive: string, into: string, password: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    // -p always given: without it 7-Zip would wait for a password on stdin. -y: never ask. -bd: no progress bar.
    const child = spawn(executable, ['x', '-y', '-bd', `-p${password ?? ''}`, `-o${into}`, '--', archive], { windowsHide: true, shell: false });
    let errors = '';
    child.stderr.on('data', data => { errors += String(data); });
    child.stdout.on('data', () => {});
    child.on('error', error => reject(new Refused('unsupported', `7-Zip could not be started: ${error.message}`)));
    child.on('close', code => {
      if (code === 0) return resolve();
      if (/wrong password/i.test(errors)) {
        return reject(new Refused('password', password ? 'The password from the item page does not open the archive.' : 'The archive is password-protected, and the item page showed no password.'));
      }
      reject(new Refused('damaged', `7-Zip could not unpack the archive (exit code ${code}): ${errors.trim().split('\n').at(-1) ?? ''}`));
    });
  });
}

// Links inside an unpacked tree could point anywhere; they are removed. Returns the file count and bytes.
async function inspect(folder: string): Promise<{ files: number; bytes: number; skipped: string[] }> {
  let files = 0;
  let bytes = 0;
  const skipped: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      await rm(path, { force: true });
      skipped.push(`${entry.name} (link removed)`);
    } else if (info.isFile()) {
      files++;
      bytes += info.size;
    }
  }
  return { files, bytes, skipped };
}

export async function extractArchive(archive: string, options: ExtractOptions): Promise<ExtractResult> {
  const head = await open(archive, 'r').then(async file => {
    try {
      return await readAt(file, 0, 16);
    } finally {
      await file.close();
    }
  });
  const kind = kindOf(head);
  if (kind === 'file') return { ok: false, reason: 'unsupported', message: 'Not an archive.' };
  if (kind !== 'zip' && !options.sevenZip) {
    return { ok: false, reason: 'unsupported', message: `Install 7-Zip to unpack ${kind.toUpperCase()} archives; the archive was kept as it is.` };
  }
  const temporary = `${options.destination}.vestigium-unpacking`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    let result: { files: number; bytes: number; skipped: string[] };
    if (kind === 'zip') result = await extractZip(archive, temporary, options.password, options.maxBytes);
    else {
      await runSevenZip(options.sevenZip!, archive, temporary, options.password);
      result = await inspect(temporary);
    }
    await rename(temporary, options.destination);
    return { ok: true, folder: options.destination, ...result };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error instanceof Refused) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: 'damaged', message: `Unpacking failed: ${error instanceof Error ? error.message : 'unknown error'}.` };
  }
}
