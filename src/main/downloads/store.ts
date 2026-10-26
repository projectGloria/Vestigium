import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DownloadJob, DownloadStatus, Item } from '../../shared/types.js';
import { DocumentRepository } from '../store/repositories.js';
import { validateDownloadJob, validateItem } from './schema.js';

// Persistence for the queue: jobs and items as validated documents, plus the lookups the queue needs (by status for
// recovery and scheduling, by hash for dedupe, items by URL for "already downloaded"). Every write is a single
// statement, so a crash leaves each document either old or new, never half-written (WAL + synchronous=FULL).
export class DownloadStore {
  readonly jobs: DocumentRepository<DownloadJob>;
  readonly items: DocumentRepository<Item>;

  constructor(private db: Database.Database) {
    this.jobs = new DocumentRepository<DownloadJob>(db, 'download_jobs', validateDownloadJob);
    this.items = new DocumentRepository<Item>(db, 'items', validateItem);
  }

  private parseJobs(rows: { document: string }[]): DownloadJob[] {
    return rows.map(row => validateDownloadJob(JSON.parse(row.document)));
  }

  withStatus(...statuses: DownloadStatus[]): DownloadJob[] {
    const marks = statuses.map(() => '?').join(',');
    return this.parseJobs(this.db.prepare(`SELECT document FROM download_jobs WHERE json_extract(document, '$.status') IN (${marks})
      ORDER BY json_extract(document, '$.createdAt'), id`).all(...statuses) as { document: string }[]);
  }

  // Newest first, for the queue table.
  recent(limit: number): DownloadJob[] {
    return this.parseJobs(this.db.prepare(`SELECT document FROM download_jobs ORDER BY json_extract(document, '$.createdAt') DESC, id DESC LIMIT ?`)
      .all(limit) as { document: string }[]);
  }

  counts(): Record<DownloadStatus, number> {
    const counts: Record<DownloadStatus, number> = { queued: 0, running: 0, paused: 0, verifying: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of this.db.prepare(`SELECT json_extract(document, '$.status') AS status, COUNT(*) AS count FROM download_jobs GROUP BY 1`).all() as { status: DownloadStatus; count: number }[]) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  // Jobs created at or after `iso` (one CLI run's downloads).
  createdSince(iso: string): DownloadJob[] {
    return this.parseJobs(this.db.prepare(`SELECT document FROM download_jobs WHERE json_extract(document, '$.createdAt') >= ?
      ORDER BY json_extract(document, '$.createdAt'), id`).all(iso) as { document: string }[]);
  }

  doneWithHash(sha256: string, except: string): DownloadJob | null {
    const row = this.db.prepare(`SELECT document FROM download_jobs WHERE json_extract(document, '$.sha256') = ? AND id <> ?
      AND json_extract(document, '$.status') = 'done' AND json_extract(document, '$.duplicateOf') IS NULL
      ORDER BY json_extract(document, '$.createdAt') LIMIT 1`).get(sha256, except) as { document: string } | undefined;
    return row ? validateDownloadJob(JSON.parse(row.document)) : null;
  }

  // Jobs for this URL that are still waiting or moving: a second click on the same link must not queue it twice.
  activeForUrl(url: string): DownloadJob | null {
    const row = this.db.prepare(`SELECT document FROM download_jobs WHERE json_extract(document, '$.url') = ?
      AND json_extract(document, '$.status') IN ('queued', 'running', 'paused', 'verifying') LIMIT 1`).get(url) as { document: string } | undefined;
    return row ? validateDownloadJob(JSON.parse(row.document)) : null;
  }

  itemByUrl(url: string): Item | null {
    const row = this.db.prepare(`SELECT document FROM items WHERE json_extract(document, '$.url') = ? LIMIT 1`).get(url) as { document: string } | undefined;
    return row ? validateItem(JSON.parse(row.document)) : null;
  }

  // Creates or updates the item for a page URL. A finished item stays finished unless `status` says otherwise.
  // New metadata is merged over what was captured before (a later visit may show more details).
  upsertItem(values: { url: string; title: string; sourcePage: string; status?: Item['status']; metadata?: Record<string, string> }): Item {
    const existing = this.itemByUrl(values.url);
    const item: Item = existing
      ? { ...existing, title: values.title || existing.title, sourcePage: values.sourcePage || existing.sourcePage, status: values.status ?? existing.status,
        metadata: { ...existing.metadata, ...values.metadata } }
      : { schemaVersion: 1, id: randomUUID(), url: values.url, title: values.title, sourcePage: values.sourcePage, metadata: values.metadata ?? {}, status: values.status ?? 'pending' };
    this.items.save(item);
    return item;
  }

  setItemStatus(itemId: string | null, status: Item['status']) {
    if (!itemId) return;
    const item = this.items.get(itemId);
    if (item && item.status !== status) this.items.save({ ...item, status });
  }
}
