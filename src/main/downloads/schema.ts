import { z } from 'zod';
import type { DownloadJob, Item } from '../../shared/types.js';
import { urlSchema } from '../validation.js';

// Strict schemas for the stored download documents; the repositories validate on every read and write.

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const path = z.string().max(4096);
const time = z.string().datetime();
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const itemSchema = z.strictObject({
  schemaVersion: z.literal(1), id, url: urlSchema, title: z.string().max(1000), sourcePage: z.union([urlSchema, z.literal('')]),
  metadata: z.record(z.string().max(200), z.string().max(10_000)), status: z.enum(['pending', 'done', 'failed', 'no_download']),
});

export const downloadJobSchema = z.strictObject({
  schemaVersion: z.literal(1), id, itemId: id.nullable(), url: urlSchema, filename: z.string().max(400), tempPath: path, finalPath: path,
  totalBytes: bytes.nullable(), receivedBytes: bytes,
  status: z.enum(['queued', 'running', 'paused', 'verifying', 'done', 'failed', 'cancelled']),
  attempts: z.number().int().min(0).max(1000), error: z.string().max(2000).nullable(),
  title: z.string().max(1000), sourcePage: urlSchema.nullable(), mimeType: z.string().max(200).nullable(),
  etag: z.string().max(500).nullable(), lastModified: z.string().max(200).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), duplicateOf: id.nullable(),
  origin: z.strictObject({ workflowId: id, stepId: id, loopStepId: id.nullable() }).nullable(),
  createdAt: time, finishedAt: time.nullable(),
  sidecarPath: path.nullable().optional(), extractedTo: path.nullable().optional(), extractNote: z.string().max(2000).nullable().optional(),
  details: z.array(z.string().max(100)).max(60).optional(),
});

export const validateItem = (value: unknown): Item => itemSchema.parse(value) as Item;
export const validateDownloadJob = (value: unknown): DownloadJob => downloadJobSchema.parse(value) as DownloadJob;
