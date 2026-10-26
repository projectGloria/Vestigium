import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DownloadJob, DownloadOrigin, DownloadRow, DownloadSettings, DownloadsState } from '../../shared/types.js';
import type { Logger } from '../logger.js';
import { applyTemplate, chooseName, sanitizeName, templateValues, uniqueName } from './filename.js';
import { extractArchive } from './archive.js';
import { writeSidecar } from './sidecar.js';
import { detailLabels, passwordOf } from '../learn/metadata.js';
import type { DownloadStore } from './store.js';
import { transfer, type Fetcher } from './transfer.js';
import { sha256File, verifyFile } from './verify.js';

// The persistent download queue (plan §5). Jobs live in SQLite; bytes live in `.part` files. Life of a job:
//   queued → running (transfer attempts, retried with backoff) → verifying (size, archive test, SHA-256)
//   → done (renamed into place, or recorded as a duplicate of identical bytes) | failed | cancelled; paused any time.
// Crash safety: the `.part` size is the resume offset, so a killed app loses at most the bytes in flight. Jobs found
// "running" or "verifying" at startup were interrupted and go back to queued. A clean quit stores them as queued.
// A dead link (404) or a failure of one job never blocks the others; each job is independent.

export interface EnqueueRequest {
  url: string; referrer: string | null; sourcePage: string | null; title: string; suggestedName: string | null;
  mimeType: string | null;
  // The item page this download belongs to (its URL is the dedupe key), and the workflow step that produced it.
  // `metadata`: details read from the page (title, tags, password …), stored with the item.
  item: { url: string; title: string; sourcePage: string; metadata?: Record<string, string> } | null;
  origin: DownloadOrigin | null;
}

export interface QueueHooks {
  // Renews an expired link by redoing the step that produced it; resolves to the fresh URL or null.
  resolve?(job: DownloadJob): Promise<string | null>;
  // Desktop notification when a batch of downloads ends.
  notify?(title: string, body: string): void;
  freeBytes?(directory: string): Promise<number>;
  // 7-Zip's executable, for unpacking 7z and RAR archives (ZIP needs nothing). Null: those archives are kept as they are.
  sevenZip?: string | null;
  labels?(): string[];
}

type Stop = 'pause' | 'cancel' | 'quit';
interface Live { controller: AbortController; received: number; total: number | null; samples: { at: number; bytes: number }[]; stop: Stop | null; savedAt: number }

const RESERVE_BYTES = 64 * 1024 * 1024; // never fill the disk to the last byte: Windows and the DB need room too
const ROWS = 200;
const PROGRESS_SAVE_MS = 1000;
const CHANGED_THROTTLE_MS = 250;

const sizeText = (bytes: number) => bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB`
  : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export class DownloadQueue {
  private live = new Map<string, Live>();
  private disposed = false;
  // "Pause all": jobs queued meanwhile wait until "Resume all".
  private held = false;
  private batch = { done: 0, failed: 0 };
  private changedTimer: NodeJS.Timeout | null = null;
  // Picking a free name and renaming into it must not interleave between two jobs, or both could pick "a (2).zip".
  private placing: Promise<unknown> = Promise.resolve();

  constructor(
    private store: DownloadStore, private settings: () => DownloadSettings, private defaultDirectory: string,
    private fetcher: Fetcher, private log: Logger, private changed: () => void, private hooks: QueueHooks = {},
  ) {}

  directory(): string {
    return this.settings().directory || this.defaultDirectory;
  }

  // Startup: interrupted jobs continue where their `.part` files stopped.
  start() {
    const interrupted = this.store.withStatus('running', 'verifying');
    let requeued = 0;
    for (const job of interrupted) {
      // Interrupted after its file was placed (while unpacking or writing the sidecar): the file is complete.
      if (job.finalPath && existsSync(job.finalPath)) {
        this.store.jobs.save({ ...job, status: 'done', finishedAt: new Date().toISOString(),
          extractNote: job.extractNote ?? 'The app closed while this was being unpacked; the file itself is complete.' });
      } else {
        this.store.jobs.save({ ...job, status: 'queued' });
        requeued++;
      }
    }
    const waiting = this.store.withStatus('queued').length;
    if (waiting) this.log.write('info', `Resuming the download queue: ${waiting} download${waiting === 1 ? '' : 's'} (${requeued} interrupted by the last shutdown).`);
    this.pump();
  }

  // True when this item page already produced a verified download and Force is off: a run skips it unopened.
  isItemDone(url: string): boolean {
    return !this.settings().force && this.store.itemByUrl(url)?.status === 'done';
  }

  markItem(item: { url: string; title: string; sourcePage: string; metadata?: Record<string, string> }, status: 'pending' | 'failed' | 'no_download') {
    const existing = this.store.itemByUrl(item.url);
    // A failure of the page never downgrades an item whose file is already here (its details may still be refreshed).
    this.store.upsertItem({ ...item, status: existing?.status === 'done' ? 'done' : status });
  }

  // The labels to look for on item pages (settings), for the runner and for manual downloads.
  metadataLabels(): string[] {
    return this.hooks.labels?.() ?? [];
  }

  enqueue(request: EnqueueRequest): DownloadJob | null {
    if (this.disposed) return null;
    const force = this.settings().force;
    let itemId: string | null = null;
    if (request.item) {
      const existing = this.store.itemByUrl(request.item.url);
      if (existing?.status === 'done' && !force) {
        this.log.write('info', `Already downloaded "${existing.title}"; skipped. Turn on Force to download it again.`);
        return null;
      }
      itemId = this.store.upsertItem({ ...request.item, status: 'pending' }).id;
    }
    const details = itemId ? detailLabels(this.store.items.get(itemId)?.metadata ?? {}) : [];
    const duplicate = this.store.activeForUrl(request.url);
    if (duplicate) {
      this.log.write('info', `"${duplicate.filename}" is already in the queue.`);
      return duplicate;
    }
    const id = randomUUID();
    const job: DownloadJob = {
      schemaVersion: 1, id, itemId, url: request.url,
      filename: chooseName({ contentDisposition: null, url: request.url, title: request.title, mimeType: request.mimeType, suggested: request.suggestedName }),
      tempPath: join(this.directory(), '.vestigium-parts', `${id}.part`), finalPath: '', totalBytes: null, receivedBytes: 0,
      status: 'queued', attempts: 0, error: null, title: request.item?.title || request.title, sourcePage: request.sourcePage ?? request.referrer,
      mimeType: request.mimeType, etag: null, lastModified: null, sha256: null, duplicateOf: null, origin: request.origin,
      createdAt: new Date().toISOString(), finishedAt: null, details,
    };
    this.store.jobs.save(job);
    this.log.write('info', `Queued download "${job.filename}"${this.held ? ' (the queue is paused)' : ''}.`);
    this.pump();
    this.changed();
    return job;
  }

  // ---------- controls: one job (id) or all (null) ----------

  pause(id: string | null) {
    if (id === null) this.held = true;
    for (const job of this.select(id, 'queued', 'running')) {
      const live = this.live.get(job.id);
      if (live) {
        live.stop = 'pause';
        live.controller.abort();
      } else this.save({ ...job, status: 'paused' });
    }
    this.log.write('info', id === null ? 'Paused all downloads.' : 'Paused a download.');
    this.changed();
  }

  resume(id: string | null) {
    if (id === null) this.held = false;
    for (const job of this.select(id, 'paused')) this.save({ ...job, status: 'queued', error: null });
    this.log.write('info', id === null ? 'Resumed all downloads.' : 'Resumed a download.');
    this.pump();
    this.changed();
  }

  cancel(id: string | null) {
    for (const job of this.select(id, 'queued', 'running', 'paused')) {
      const live = this.live.get(job.id);
      if (live) {
        live.stop = 'cancel';
        live.controller.abort();
      } else {
        this.save({ ...job, status: 'cancelled', finishedAt: new Date().toISOString() });
        void rm(job.tempPath, { force: true });
      }
    }
    this.log.write('info', id === null ? 'Cancelled all downloads.' : 'Cancelled a download.');
    this.changed();
  }

  // Failed (or cancelled) jobs start over with fresh attempts; a kept `.part` is resumed.
  retry(id: string | null) {
    const jobs = this.select(id, 'failed', 'cancelled');
    for (const job of jobs) this.save({ ...job, status: 'queued', attempts: 0, error: null, finishedAt: null });
    if (jobs.length) this.log.write('info', `Retrying ${jobs.length} download${jobs.length === 1 ? '' : 's'}.`);
    this.pump();
    this.changed();
  }

  private select(id: string | null, ...statuses: DownloadJob['status'][]): DownloadJob[] {
    if (id === null) return this.store.withStatus(...statuses);
    const job = this.store.jobs.get(id);
    return job && statuses.includes(job.status) ? [job] : [];
  }

  // Clean quit: running jobs are stored as queued with their byte counts *now* (the DB closes right after this), then
  // their transfers are aborted; the aborted transfers find `disposed` set and write nothing more.
  dispose() {
    for (const [id, live] of this.live) {
      const job = this.store.jobs.get(id);
      if (job && (job.status === 'running' || job.status === 'verifying')) this.store.jobs.save({ ...job, status: 'queued', receivedBytes: live.received });
      live.stop = 'quit';
    }
    this.disposed = true;
    for (const live of this.live.values()) live.controller.abort();
    if (this.changedTimer) clearTimeout(this.changedTimer);
  }

  // ---------- scheduling ----------

  private save(job: DownloadJob) {
    if (!this.disposed) this.store.jobs.save(job);
  }

  private pump() {
    if (this.disposed || this.held) return;
    const free = this.settings().concurrency - this.live.size;
    if (free <= 0) return;
    for (const job of this.store.withStatus('queued').filter(job => !this.live.has(job.id)).slice(0, free)) void this.run(job);
  }

  private async run(job: DownloadJob) {
    const live: Live = { controller: new AbortController(), received: job.receivedBytes, total: job.totalBytes, samples: [], stop: null, savedAt: 0 };
    this.live.set(job.id, live);
    try {
      await this.process({ ...job, status: 'running', error: null }, live);
    } catch (error) {
      // Anything unexpected (disk full, permissions) fails this job only.
      if (!this.disposed) {
        const current = this.store.jobs.get(job.id) ?? job;
        this.finish({ ...current, status: 'failed', error: `Unexpected error: ${error instanceof Error ? error.message : 'unknown'}` }, 'failed');
      }
    } finally {
      this.live.delete(job.id);
      if (!this.disposed) {
        this.pump();
        this.idleCheck();
        this.changed();
      }
    }
  }

  private async process(job: DownloadJob, live: Live) {
    this.save(job);
    this.changed();
    const signal = live.controller.signal;
    await mkdir(dirname(job.tempPath), { recursive: true });
    let renewed = false;
    let named = false;
    for (;;) {
      const space = await this.spaceProblem(job);
      if (space) {
        this.save({ ...job, status: 'paused', error: space });
        this.log.write('warn', `Paused "${job.filename}": ${space}`);
        return;
      }
      job = { ...job, attempts: job.attempts + 1 };
      this.save(job);
      const result = await transfer(this.fetcher, {
        url: job.url, referrer: job.sourcePage, partPath: job.tempPath, validator: { etag: job.etag, lastModified: job.lastModified }, signal,
        onHeaders: info => {
          // The first response that names the file decides; a resumed 206 often carries no Content-Disposition.
          const filename = !named && (info.contentDisposition || !info.resumed)
            ? chooseName({ contentDisposition: info.contentDisposition, url: job.url, title: job.title, mimeType: info.mimeType ?? job.mimeType, suggested: job.filename })
            : job.filename;
          named = named || Boolean(info.contentDisposition) || !info.resumed;
          job = { ...job, filename, totalBytes: info.totalBytes, etag: info.etag ?? job.etag, lastModified: info.lastModified ?? job.lastModified,
            mimeType: info.mimeType ?? job.mimeType };
          live.total = info.totalBytes;
          live.received = info.offset;
          if (info.resumed) this.log.write('info', `Resuming "${job.filename}" at ${sizeText(info.offset)}${info.totalBytes ? ` of ${sizeText(info.totalBytes)}` : ''}.`);
          this.save(job);
          this.changed();
        },
        onProgress: (received, total) => this.progress(job, live, received, total),
      });
      if (result.ok) {
        if (result.restarted) this.log.write('info', `"${job.filename}" restarted from zero: the server did not continue the partial file.`);
        job = { ...job, receivedBytes: result.receivedBytes, totalBytes: result.info.totalBytes };
        break;
      }
      if (result.kind === 'aborted') return this.stopped(job, live);
      if (result.kind === 'expired' && !renewed && this.hooks.resolve) {
        renewed = true;
        this.log.write('warn', `"${job.filename}": ${result.message} Reopening the page it came from to get a fresh link.`);
        const fresh = await this.hooks.resolve(job).catch(() => null);
        if (this.disposed) return;
        if (fresh) {
          job = { ...job, url: fresh };
          this.save(job);
          this.log.write('info', `Got a fresh link for "${job.filename}"; continuing from ${sizeText(await fileSize(job.tempPath))}.`);
          continue;
        }
      }
      const retries = this.settings().retries;
      if (result.retryable && job.attempts <= retries) {
        const wait = Math.min(30_000, 1000 * 2 ** (job.attempts - 1));
        this.log.write('warn', `"${job.filename}": ${result.message} Retrying in ${wait / 1000} s (attempt ${job.attempts + 1} of ${retries + 1}).`);
        this.save({ ...job, error: result.message });
        const slept = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(true), wait);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
        });
        if (!slept) return this.stopped(job, live);
        continue;
      }
      // Bytes from a dead link or an error page are worthless; bytes from a network failure are kept for "Retry".
      if (result.kind === 'dead' || result.kind === 'html' || result.kind === 'expired') await rm(job.tempPath, { force: true });
      this.finish({ ...job, status: 'failed', error: result.message }, result.kind === 'dead' ? 'no_download' : 'failed');
      return;
    }
    await this.complete(job, signal);
  }

  private progress(job: DownloadJob, live: Live, received: number, total: number | null) {
    const now = Date.now();
    live.received = received;
    live.total = total;
    live.samples.push({ at: now, bytes: received });
    while (live.samples.length > 2 && now - live.samples[0].at > 5000) live.samples.shift();
    if (now - live.savedAt >= PROGRESS_SAVE_MS) {
      live.savedAt = now;
      this.save({ ...job, receivedBytes: received, totalBytes: total });
    }
    this.changedSoon();
  }

  private stopped(job: DownloadJob, live: Live) {
    if (this.disposed || live.stop === 'quit') return; // dispose() already stored it as queued
    if (live.stop === 'cancel') {
      this.save({ ...job, status: 'cancelled', receivedBytes: live.received, finishedAt: new Date().toISOString() });
      void rm(job.tempPath, { force: true });
    } else {
      this.save({ ...job, status: 'paused', receivedBytes: live.received });
    }
  }

  // Item page details for this job (template values, sidecar, the archive password).
  private metadataOf(job: DownloadJob): Record<string, string> {
    return (job.itemId ? this.store.items.get(job.itemId)?.metadata : null) ?? {};
  }

  private async complete(job: DownloadJob, signal: AbortSignal) {
    job = { ...job, status: 'verifying', error: null };
    this.save(job);
    this.changed();
    const verdict = await verifyFile(job.tempPath, { totalBytes: job.totalBytes, name: job.filename });
    if (this.disposed) return;
    if (!verdict.ok) {
      await rm(job.tempPath, { force: true });
      this.finish({ ...job, status: 'failed', error: verdict.message }, 'failed');
      return;
    }
    const sha256 = await sha256File(job.tempPath, signal).catch(() => null);
    if (this.disposed || sha256 === null) return;
    const same = this.settings().force ? null : this.store.doneWithHash(sha256, job.id);
    if (same && existsSync(same.finalPath)) {
      await rm(job.tempPath, { force: true });
      this.finish({ ...job, status: 'done', sha256, duplicateOf: same.id, finalPath: same.finalPath }, 'done',
        `Downloaded "${job.title || job.filename}": identical to "${same.filename}", which is already saved; not stored twice.`);
      return;
    }
    const metadata = this.metadataOf(job);
    const settings = this.settings();
    const values = templateValues({ site: sanitizeName(hostOf(job.sourcePage ?? job.url) || 'downloads'), filename: job.filename, title: job.title, metadata });
    const planned = applyTemplate(settings.template, values);
    const folder = join(this.directory(), ...planned.folders);
    const place = this.placing.then(async () => {
      await mkdir(folder, { recursive: true });
      const name = uniqueName(planned.name, candidate => existsSync(join(folder, candidate)));
      const finalPath = join(folder, name);
      await rename(job.tempPath, finalPath);
      return { name, finalPath };
    });
    this.placing = place.catch(() => {});
    const { name, finalPath } = await place;
    // Still "verifying" while it is unpacked and its sidecar written ("done" means all of it is finished), but the
    // final path is saved now: after a crash here, start() completes the job instead of downloading it again.
    job = { ...job, status: 'verifying', sha256, filename: name, finalPath, details: detailLabels(metadata) };
    this.save(job);
    const after = await this.afterPlacing(job, folder, name, metadata, verdict.kind !== 'file');
    if (this.disposed) return;
    job = { ...job, ...after, status: 'done' };
    const note = [verdict.note, after.extractNote, after.sidecarPath ? 'Sidecar written.' : ''].filter(Boolean).join(' ');
    this.finish(job, 'done', `Downloaded "${name}" (${sizeText(job.totalBytes ?? 0)}) to ${finalPath}.${note ? ` ${note}` : ''}`);
  }

  // Optional steps once the file is in place: unpack an archive with the item page's password, then write the sidecar.
  // Failures here never fail the download; they are noted on the job ("Not unpacked: …").
  private async afterPlacing(job: DownloadJob, folder: string, name: string, metadata: Record<string, string>, archive: boolean) {
    const settings = this.settings();
    let extractedTo: string | null = null;
    let extractNote: string | null = null;
    let finalPath = job.finalPath;
    if (archive && settings.extract !== 'off') {
      const stem = name.replace(/\.[^.]{1,16}$/, '');
      const destination = join(folder, uniqueName(stem, candidate => existsSync(join(folder, candidate))));
      let free = Number.MAX_SAFE_INTEGER;
      try {
        free = this.hooks.freeBytes ? await this.hooks.freeBytes(folder) : await statfs(folder).then(info => info.bavail * info.bsize);
      } catch { /* unknown free space: the per-entry size checks still apply */ }
      const result = await extractArchive(job.finalPath, {
        password: passwordOf(metadata), destination, sevenZip: this.hooks.sevenZip ?? null, maxBytes: Math.max(0, free - RESERVE_BYTES),
      });
      if (result.ok) {
        extractedTo = result.folder;
        const skipped = result.skipped.length ? ` (${result.skipped.length} skipped: ${result.skipped.slice(0, 3).join('; ')})` : '';
        extractNote = `Unpacked ${result.files} file${result.files === 1 ? '' : 's'} into ${result.folder}${skipped}.`;
        if (settings.extract === 'delete') {
          await rm(job.finalPath, { force: true });
          finalPath = result.folder;
          extractNote += ' The archive was deleted.';
        }
      } else {
        extractNote = `Not unpacked: ${result.message}`;
        this.log.write('warn', `"${name}" ${extractNote.charAt(0).toLowerCase()}${extractNote.slice(1)}`);
      }
    }
    let sidecarPath: string | null = null;
    if (settings.sidecar) {
      try {
        sidecarPath = await writeSidecar({
          file: name, folder, title: job.title, page: job.sourcePage, url: job.url, bytes: job.totalBytes ?? job.receivedBytes,
          sha256: job.sha256 ?? '', savedAt: new Date().toISOString(), metadata, extractedTo,
        });
      } catch (error) {
        this.log.write('warn', `The sidecar for "${name}" could not be written: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return { extractedTo, extractNote, sidecarPath, finalPath };
  }

  private finish(job: DownloadJob, itemStatus: 'done' | 'failed' | 'no_download', message?: string) {
    if (this.disposed) return;
    this.save({ ...job, finishedAt: new Date().toISOString(), receivedBytes: job.status === 'done' ? job.totalBytes ?? job.receivedBytes : job.receivedBytes });
    this.store.setItemStatus(job.itemId, itemStatus);
    if (job.status === 'done') {
      this.batch.done++;
      this.log.write('info', message ?? `Downloaded "${job.filename}".`);
    } else {
      this.batch.failed++;
      this.log.write('warn', `Download failed: "${job.filename}". ${job.error ?? ''}`.trim());
    }
    this.changed();
  }

  private async spaceProblem(job: DownloadJob): Promise<string | null> {
    const directory = this.directory();
    await mkdir(directory, { recursive: true });
    let free: number;
    try {
      free = this.hooks.freeBytes ? await this.hooks.freeBytes(directory) : await statfs(directory).then(info => info.bavail * info.bsize);
    } catch {
      return null; // unknown free space must not stop downloads
    }
    const needed = Math.max(0, (job.totalBytes ?? 0) - await fileSize(job.tempPath)) + RESERVE_BYTES;
    return free < needed ? `Not enough free disk space in ${directory}: ${sizeText(free)} free, ${sizeText(needed)} needed. Free some space, then resume.` : null;
  }

  private idleCheck() {
    if (this.live.size > 0 || this.store.withStatus('queued').length > 0 || this.batch.done + this.batch.failed === 0) return;
    const { done, failed } = this.batch;
    this.batch = { done: 0, failed: 0 };
    const body = `${done} downloaded${failed ? `, ${failed} failed` : ''}.`;
    this.log.write('info', `Download queue finished: ${body}`);
    this.hooks.notify?.('Vestigium downloads finished', body);
  }

  private changedSoon() {
    if (this.changedTimer || this.disposed) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      if (!this.disposed) this.changed();
    }, CHANGED_THROTTLE_MS);
  }

  // What happened to the downloads queued since `iso` (the CLI's report): still moving, done, failed, paused, and the
  // files kept (a duplicate of identical bytes points at the file already there).
  summarySince(iso: string): { active: number; done: number; failed: number; paused: number; files: string[] } {
    const jobs = this.store.createdSince(iso);
    const active = jobs.filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'verifying'
      || (job.status === 'done' && !job.finishedAt)).length;
    const done = jobs.filter(job => job.status === 'done');
    return {
      active, done: done.length, failed: jobs.filter(job => job.status === 'failed').length, paused: jobs.filter(job => job.status === 'paused').length,
      files: [...new Set(done.map(job => job.finalPath).filter(Boolean))],
    };
  }

  // ---------- view ----------

  state(): DownloadsState {
    const counts = this.store.counts();
    const rows: DownloadRow[] = this.store.recent(ROWS).map(job => {
      const live = this.live.get(job.id);
      const received = live ? live.received : job.receivedBytes;
      const total = live ? live.total ?? job.totalBytes : job.totalBytes;
      let bytesPerSecond: number | null = null;
      if (live && live.samples.length >= 2) {
        const first = live.samples[0];
        const last = live.samples[live.samples.length - 1];
        if (last.at > first.at) bytesPerSecond = Math.round((last.bytes - first.bytes) / ((last.at - first.at) / 1000));
      }
      const etaSeconds = bytesPerSecond && total !== null && bytesPerSecond > 0 ? Math.ceil((total - received) / bytesPerSecond) : null;
      return {
        id: job.id, title: job.title, filename: job.filename, url: job.url, status: job.status, receivedBytes: received, totalBytes: total,
        bytesPerSecond, etaSeconds, error: job.error, finalPath: job.finalPath || null, duplicateOf: job.duplicateOf, attempts: job.attempts,
        details: job.details ?? [], extractedTo: job.extractedTo ?? null, extractNote: job.extractNote ?? null,
      };
    });
    const counted = rows.filter(row => row.status !== 'cancelled' && row.status !== 'failed');
    const unknown = counted.some(row => row.totalBytes === null);
    return {
      rows, directory: this.directory(), held: this.held,
      counts: { queued: counts.queued, running: counts.running + counts.verifying, paused: counts.paused, done: counts.done, failed: counts.failed, cancelled: counts.cancelled },
      receivedBytes: counted.reduce((sum, row) => sum + row.receivedBytes, 0),
      totalBytes: unknown ? null : counted.reduce((sum, row) => sum + (row.totalBytes ?? 0), 0),
    };
  }
}
