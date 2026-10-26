import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request, Response } from 'express';
import { ZipFile } from 'yazl';
import { FILENAMES, ZIP_TEXT } from './fixtures.js';

export async function makeZip(): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(ZIP_TEXT), 'readme.txt', { mtime: new Date('2026-01-01T00:00:00Z') });
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  const completed = once(zip.outputStream, 'end');
  zip.end();
  await completed;
  return Buffer.concat(chunks);
}
// Password-protected archives made with 7-Zip (password PASSWORD in fixtures.ts), so Vestigium's own decryption is
// checked against an independent encoder. Each holds notes/readme.txt (ZIP_TEXT) and notes/photo-list.txt.
// Read relative to the working directory (the repo root for every test runner), because bundlers move this module.
export const ARCHIVES = {
  encrypted: { file: 'zipcrypto.zip', name: 'field-notes-protected.zip', type: 'application/zip' },
  aes: { file: 'aes256.zip', name: 'field-notes-aes.zip', type: 'application/zip' },
  sevenzip: { file: 'archive.7z', name: 'field-notes.7z', type: 'application/x-7z-compressed' },
} as const;
export const archiveBytes = (kind: keyof typeof ARCHIVES) => readFileSync(resolve('tests/demo-site/archives', ARCHIVES[kind].file));
// photo-list.txt was written on Windows in text mode, so its lines end with CRLF inside the archives.
export const PHOTO_LIST = Array.from({ length: 2000 }, (_, index) => `photo ${String(index).padStart(4, '0')}.jpg\r\n`).join('');

export function generatedChunk(offset: number, length: number) {
  const chunk = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) chunk[i] = (offset + i) % 251;
  return chunk;
}
export async function sendDownload(req: Request, res: Response, options: {
  zip: Buffer; largeBytes: number; throttleBytesPerSecond: number; rangeEnabled: boolean;
}) {
  const kind = String(req.params.kind);
  if (kind === 'dead') { res.status(404).type('text').send('Download is no longer available.'); return; }
  if (kind === 'html') { res.type('html').send('<!doctype html><title>Download unavailable</title><h1>File host error</h1><p>Please try later.</p>'); return; }
  const large = kind === 'large';
  const archive = kind in ARCHIVES ? kind as keyof typeof ARCHIVES : null;
  const body = archive ? archiveBytes(archive) : options.zip;
  const size = large ? options.largeBytes : body.length;
  const rangeEnabled = options.rangeEnabled && req.query.range !== 'off';
  let start = 0, end = size - 1;
  if (rangeEnabled) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', large ? `"generated-v1-${size}"` : archive ? `"demo-${archive}-v1"` : '"demo-zip-v1"');
  if (rangeEnabled && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === res.getHeader('ETag'))) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.status(416).set('Content-Range', `bytes */${size}`).send('Invalid byte range.'); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.status(416).set('Content-Range', `bytes */${size}`).send('Requested range is outside the file.'); return;
    }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  const filename = archive ? ARCHIVES[archive].name : FILENAMES[kind as keyof typeof FILENAMES] ?? (large ? 'generated.bin' : 'field-notes.zip');
  if (kind !== 'url' && kind !== 'none') res.setHeader('Content-Disposition', `attachment; filename="download.${large ? 'bin' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`);
  res.setHeader('Content-Type', large ? 'application/octet-stream' : archive ? ARCHIVES[archive].type : 'application/zip');
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') { res.end(); return; }
  const requestedThrottle = req.query.throttle === undefined ? options.throttleBytesPerSecond : Number(req.query.throttle);
  if (!Number.isFinite(requestedThrottle) || requestedThrottle < 0) { res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition'); res.status(400).send('Throttle must be a nonnegative byte rate.'); return; }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  try {
    // Limit chunks to about 100 ms at the requested rate; honor backpressure and cancellation.
    const chunkSize = requestedThrottle ? Math.max(1, Math.min(64 * 1024, Math.floor(requestedThrottle / 10))) : 64 * 1024;
    for (let offset = start; offset <= end && !res.destroyed;) {
      const length = Math.min(chunkSize, end - offset + 1);
      if (requestedThrottle) await delay(length / requestedThrottle * 1000, undefined, { signal: controller.signal });
      const chunk = large ? generatedChunk(offset, length) : body.subarray(offset, offset + length);
      if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      offset += length;
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { res.off('close', onClose); }
}
