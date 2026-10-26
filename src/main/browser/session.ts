import { safeStorage, session, type Session, type Cookie, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { Fetcher } from '../downloads/transfer.js';

export function denyPermissions(target: Session) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}
// What Chromium knew when it offered the download. `referrer`/`pageTitle` describe the page that asked for it.
export interface DownloadRequest {
  url: string; filename: string | null; mimeType: string | null; totalBytes: number | null; referrer: string | null; pageTitle: string;
}
export interface SessionHooks { onDownload?: (contents: WebContents, download: DownloadRequest) => void }
export async function createBrowserSession(userData: string, log: Logger, hooks: SessionHooks = {}) {
  const browserSession = session.fromPartition('persist:vestigium');
  denyPermissions(browserSession);
  browserSession.on('will-download', (event, item, contents) => {
    // Chromium's own download is cancelled: the queue fetches the file itself (resumable, verified, persistent).
    // Read the item first; the recorder and the runner need to know which tab asked for which file.
    const page = contents && !contents.isDestroyed() ? contents.getURL() : '';
    const download: DownloadRequest = {
      url: item.getURL(), filename: item.getFilename() || null, mimeType: item.getMimeType() || null,
      totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
      referrer: /^https?:/.test(page) ? page : null, pageTitle: contents && !contents.isDestroyed() ? contents.getTitle() : '',
    };
    event.preventDefault();
    log.write('info', `Download requested (${download.filename ?? 'unnamed file'}).`);
    hooks.onDownload?.(contents, download);
  });
  const snapshotPath = join(userData, 'session-cookies.enc');
  const encrypted = await safeStorage.isAsyncEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  if (encrypted && existsSync(snapshotPath)) {
    try {
      const decrypted = await safeStorage.decryptStringAsync(await readFile(snapshotPath));
      const snapshot = JSON.parse(decrypted.result) as { schemaVersion: number; cookies: Cookie[] };
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.cookies)) throw new Error('Unsupported session snapshot.');
      for (const cookie of snapshot.cookies) {
        const host = cookie.domain?.replace(/^\./, '');
        if (!host || !cookie.session) continue;
        await browserSession.cookies.set({
          url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
          name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? undefined : cookie.domain,
          path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
        });
      }
      // Consume the snapshot so a later crash cannot replay stale logged-out sessions.
      await rm(snapshotPath, { force: true });
      log.write('info', 'Encrypted browser session restored.');
    } catch { log.write('warn', 'Saved browser session could not be restored. Sign in again if needed.'); await rm(snapshotPath, { force: true }); }
  }
  if (!encrypted) log.write('warn', 'OS encryption is unavailable. Session-only cookies will not be saved across restarts.');
  // The queue's fetcher: Chromium's network stack with this session's cookies, so files behind a login download too.
  // Cookies must be asked for explicitly (Electron blocks them unless `credentials` is set). net.fetch ignores
  // RequestInit.referrer, so the page goes in as a Referer header (some hosts refuse hotlinked files without it).
  const fetcher: Fetcher = (url, init) => browserSession.fetch(url, {
    headers: { ...init.headers, ...(init.referrer ? { Referer: init.referrer } : {}) }, signal: init.signal, credentials: 'include', redirect: 'follow',
  });
  return {
    session: browserSession,
    fetcher,
    async save() {
      if (encrypted) {
        const cookies = (await browserSession.cookies.get({})).filter(cookie => cookie.session);
        const bytes = await safeStorage.encryptStringAsync(JSON.stringify({ schemaVersion: 1, cookies }));
        await writeFile(`${snapshotPath}.tmp`, bytes, { mode: 0o600 });
        await rename(`${snapshotPath}.tmp`, snapshotPath);
      }
      browserSession.flushStorageData();
      await browserSession.cookies.flushStore();
    },
  };
}
