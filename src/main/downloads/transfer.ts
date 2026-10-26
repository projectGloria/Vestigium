import { open, stat, truncate } from 'node:fs/promises';

// One HTTP attempt at a file, appended to its `.part` file. Pure Node apart from the injected fetcher (the app passes
// the browser session's fetch so cookies and the site's login apply; unit tests pass Node's fetch).
//
// Resume rules:
// - The `.part` file's size is the offset. With an offset, the request carries `Range: bytes=<offset>-` and, when a
//   validator is known, `If-Range`, so a changed file comes back whole (200) instead of being spliced.
// - 206 with the requested start: append. 200 to a range request (no Range support, or If-Range mismatch): truncate
//   and start over. 416: the part already holds the whole file (Content-Range "*/<size>" equals the offset), or it is
//   bogus; then truncate and start over once.
// - 404 is a dead link; 401/403/410 an expired or refused link (worth re-resolving); 408/425/429/5xx and network errors
//   are retried by the queue. A web page where a file was expected (text/html) is a host error page.

export interface FetchInit { headers: Record<string, string>; signal: AbortSignal; referrer: string | null }
export type Fetcher = (url: string, init: FetchInit) => Promise<Response>;

export interface TransferRequest {
  url: string; referrer: string | null; partPath: string;
  validator: { etag: string | null; lastModified: string | null };
  signal: AbortSignal;
  // Called once the response headers are accepted (before the body), then as bytes arrive (totals include the offset).
  onHeaders?(headers: ResponseInfo): void;
  onProgress?(receivedBytes: number, totalBytes: number | null): void;
}

export interface ResponseInfo {
  totalBytes: number | null; etag: string | null; lastModified: string | null; contentDisposition: string | null;
  mimeType: string | null; resumed: boolean; offset: number;
}

export type FailureKind = 'dead' | 'expired' | 'html' | 'http' | 'network' | 'aborted';
export type TransferResult =
  | { ok: true; info: ResponseInfo; receivedBytes: number; restarted: boolean }
  | { ok: false; kind: FailureKind; message: string; retryable: boolean; status?: number };

const fail = (kind: FailureKind, message: string, retryable: boolean, status?: number): TransferResult =>
  ({ ok: false, kind, message, retryable, ...(status ? { status } : {}) });

async function partSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function header(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value === null || value === '' ? null : value;
}

// Weak ETags (W/"…") may not be used with If-Range (RFC 9110 §13.1.5); Last-Modified is the fallback validator.
function ifRange(validator: TransferRequest['validator']): string | null {
  if (validator.etag && !validator.etag.startsWith('W/')) return validator.etag;
  return validator.lastModified;
}

function classifyStatus(status: number, statusText: string): TransferResult {
  const text = `${status}${statusText ? ` ${statusText}` : ''}`;
  if (status === 404) return fail('dead', `The download link is dead (${text}).`, false, status);
  if (status === 401 || status === 403 || status === 410) {
    return fail('expired', `The server refused the download link (${text}); it has probably expired.`, false, status);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return fail('http', `The server is not ready (${text}).`, true, status);
  }
  return fail('http', `The server answered ${text}.`, false, status);
}

export async function transfer(fetcher: Fetcher, request: TransferRequest): Promise<TransferResult> {
  let restarted = false;
  // At most one restart from zero per attempt: a server that keeps answering a fresh request with 416 is broken.
  for (let pass = 0; pass < 2; pass++) {
    const offset = await partSize(request.partPath);
    // Byte offsets must refer to the bytes on disk, so ask for no content encoding (a gzip stream has other offsets).
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    const validator = ifRange(request.validator);
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      if (validator) headers['If-Range'] = validator;
    }
    let response: Response;
    try {
      response = await fetcher(request.url, { headers, signal: request.signal, referrer: request.referrer });
    } catch (error) {
      if (request.signal.aborted) return fail('aborted', 'Stopped.', false);
      return fail('network', `Network error: ${error instanceof Error ? error.message : 'request failed'}.`, true);
    }

    if (response.status === 416 && offset > 0) {
      await response.body?.cancel().catch(() => {});
      const size = /^bytes \*\/(\d+)$/.exec(header(response, 'content-range') ?? '');
      if (size && Number(size[1]) === offset) {
        // The previous attempt received everything but stopped before it could finish (crash, quit).
        const info = { totalBytes: offset, etag: request.validator.etag, lastModified: request.validator.lastModified,
          contentDisposition: null, mimeType: null, resumed: true, offset };
        request.onHeaders?.(info);
        return { ok: true, info, receivedBytes: offset, restarted };
      }
      await truncate(request.partPath, 0);
      restarted = true;
      continue;
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return classifyStatus(response.status, response.statusText);
    }

    const mimeType = header(response, 'content-type');
    if (mimeType && /^(text\/html|application\/xhtml\+xml)\b/i.test(mimeType)) {
      await response.body?.cancel().catch(() => {});
      return fail('html', 'The file host sent a web page instead of the file (probably an error or a "try later" page).', false);
    }
    const encoding = header(response, 'content-encoding');
    let start = 0;
    let totalBytes: number | null = null;
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header(response, 'content-range') ?? '');
      if (!range || Number(range[1]) !== offset) {
        // A range we did not ask for: the only safe move is a clean restart.
        await response.body?.cancel().catch(() => {});
        await truncate(request.partPath, 0);
        restarted = true;
        continue;
      }
      start = offset;
      totalBytes = range[3] === '*' ? null : Number(range[3]);
    } else {
      // 200: the whole file. Either no range was asked for, or the server ignored it (no Range support, or If-Range
      // said the file changed). Bytes already on disk are useless then.
      if (offset > 0) restarted = true;
      const length = header(response, 'content-length');
      totalBytes = length !== null && !encoding ? Number(length) : null;
      if (totalBytes !== null && !Number.isSafeInteger(totalBytes)) totalBytes = null;
    }
    const info: ResponseInfo = {
      totalBytes, etag: header(response, 'etag'), lastModified: header(response, 'last-modified'),
      contentDisposition: header(response, 'content-disposition'), mimeType, resumed: start > 0, offset: start,
    };
    request.onHeaders?.(info);

    const file = await open(request.partPath, start > 0 ? 'a' : 'w');
    let received = start;
    try {
      if (!response.body) return fail('network', 'The server sent no file body.', true);
      const reader = response.body.getReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (request.signal.aborted) return fail('aborted', 'Stopped.', false);
          return fail('network', `The connection dropped after ${received} bytes: ${error instanceof Error ? error.message : 'read failed'}.`, true);
        }
        if (chunk.done) break;
        // Awaiting each write is the backpressure: a slow disk slows the reads instead of filling memory.
        await file.write(chunk.value);
        received += chunk.value.byteLength;
        request.onProgress?.(received, totalBytes);
      }
      // Flushed before the queue renames it: a crash right after "done" must not leave a short final file.
      await file.sync();
    } finally {
      await file.close();
    }
    if (totalBytes !== null && received !== totalBytes) {
      return fail('network', `The connection ended early: ${received} of ${totalBytes} bytes.`, true);
    }
    return { ok: true, info: { ...info, totalBytes: totalBytes ?? received }, receivedBytes: received, restarted };
  }
  return fail('http', 'The server keeps rejecting the byte range, even for a fresh download.', false, 416);
}
