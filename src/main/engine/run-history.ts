import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { RunRecord, RunState } from '../../shared/types.js';
import type { DocumentRepository } from '../store/repositories.js';

// Run history (plan §6): each finished run is stored in run_log, so the History tab outlives a restart. A record
// keeps the counts, the first failure (for "Re-teach this step") and up to 50 failed steps and items with their
// messages and screenshots. The newest 200 runs are kept.

const MAX_FAILURES = 50;
const KEEP = 200;

const resultSchema = z.strictObject({
  stepId: z.string().max(200), label: z.string().max(2000), status: z.enum(['done', 'skipped', 'failed']), message: z.string().max(4000),
  locator: z.string().max(2000).nullable(), screenshot: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/).nullable().optional(),
});
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), workflowId: z.string().max(128), workflowName: z.string().max(300),
  mode: z.enum(['run', 'step', 'dry']), status: z.enum(['running', 'paused', 'done', 'failed', 'stopped']),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(), error: z.string().max(4000).nullable(),
  done: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0),
  failure: z.strictObject({ stepId: z.string().max(200), label: z.string().max(2000), url: z.string().max(8192) }).nullable(),
  failures: z.array(resultSchema).max(MAX_FAILURES),
});
export const validateRunRecord = (value: unknown): RunRecord => recordSchema.parse(value) as RunRecord;

export function recordOf(run: RunState): RunRecord {
  const count = (status: 'done' | 'failed' | 'skipped') => run.results.filter(result => result.status === status).length;
  return {
    schemaVersion: 1, id: randomUUID(), workflowId: run.workflowId, workflowName: run.workflowName, mode: run.mode, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, done: count('done'), failed: count('failed'), skipped: count('skipped'),
    failure: run.failure,
    failures: run.results.filter(result => result.status === 'failed').slice(0, MAX_FAILURES)
      .map(result => ({ ...result, label: result.label.slice(0, 2000), message: result.message.slice(0, 4000), screenshot: result.screenshot ?? null })),
  };
}

export class RunHistory {
  private cache: RunRecord[] | null = null;

  constructor(private repository: DocumentRepository<RunRecord>, private db: Database.Database) {}

  add(run: RunState) {
    this.repository.save(recordOf(run));
    // Keep the newest KEEP runs; older ones (and their screenshots' references) go.
    this.db.prepare(`DELETE FROM run_log WHERE id NOT IN (SELECT id FROM run_log ORDER BY json_extract(document, '$.startedAt') DESC LIMIT ${KEEP})`).run();
    this.cache = null;
  }

  // Newest first. Cached: AppState is rebuilt on every change, and history only changes when a run ends.
  recent(limit = 20): RunRecord[] {
    if (!this.cache) {
      const rows = this.db.prepare(`SELECT document FROM run_log ORDER BY json_extract(document, '$.startedAt') DESC LIMIT ?`).all(limit) as { document: string }[];
      this.cache = rows.flatMap(row => {
        try {
          return [validateRunRecord(JSON.parse(row.document))];
        } catch {
          return []; // a damaged record is skipped, never fatal
        }
      });
    }
    return this.cache;
  }

  screenshots(): Set<string> {
    return new Set(this.recent(KEEP).flatMap(record => record.failures.map(result => result.screenshot).filter((name): name is string => Boolean(name))));
  }
}
