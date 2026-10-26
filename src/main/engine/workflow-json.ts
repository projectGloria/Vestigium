import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import type { Workflow } from '../../shared/types.js';
import { workflowSchema } from './workflow-schema.js';

// Human-readable, diff-friendly workflow files: validated, fixed key order, 2-space indent, trailing newline.

export const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;

export class WorkflowFormatError extends Error {
  override name = 'WorkflowFormatError';
}

// Keys listed here come first in this order (identity, then behavior, then the noisy locator lists);
// any other key follows alphabetically. One global order keeps every nesting level deterministic.
const KEY_ORDER = [
  'schemaVersion', 'id', 'name', 'version', 'siteProfileId', 'createdAt', 'variables',
  'type', 'label', 'enabled', 'target', 'params', 'waitFor', 'timeoutMs', 'onFail', 'review',
  'kind', 'template', 'pagination', 'maxPages', 'pattern', 'listUrl', 'maxItems', 'exclude', 'locators', 'steps',
  'parent', 'container', 'item', 'link', 'description',
  'reason', 'at', 'previous',
  'tab', 'frames', 'shadowHosts', 'url', 'index', 'strategy', 'value', 'confidence',
];
const rank = new Map(KEY_ORDER.map((key, index) => [key, index]));

function compareKeys(a: string, b: string) {
  const ra = rank.get(a) ?? Infinity;
  const rb = rank.get(b) ?? Infinity;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).sort(([a], [b]) => compareKeys(a, b));
  return Object.fromEntries(entries.map(([key, child]) => [key, canonical(child)]));
}

// Zod messages carry a path; the user sees e.g. "steps.2.locators: A click step needs at least one locator."
export function describeIssues(error: z.ZodError, limit = 5): string {
  const lines = error.issues.slice(0, limit).map(issue => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - lines.length;
  return lines.join('; ') + (more > 0 ? `; and ${more} more problem${more === 1 ? '' : 's'}` : '');
}

export function validateWorkflow(value: unknown): Workflow {
  const result = workflowSchema.safeParse(value);
  if (!result.success) throw new WorkflowFormatError(`Workflow is invalid: ${describeIssues(result.error)}`);
  return result.data;
}

export function serializeWorkflow(workflow: Workflow): string {
  // Validate on the way out too: an invalid workflow must never reach disk, where it would fail on import later.
  return JSON.stringify(canonical(validateWorkflow(workflow)), null, 2) + '\n';
}

export function parseWorkflow(text: string): Workflow {
  if (Buffer.byteLength(text, 'utf8') > MAX_WORKFLOW_BYTES) {
    throw new WorkflowFormatError(`Workflow file is larger than ${MAX_WORKFLOW_BYTES / 1024 / 1024} MiB.`);
  }
  let data: unknown;
  try {
    // Editors on Windows often save UTF-8 with a BOM, which JSON.parse rejects.
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown syntax error';
    throw new WorkflowFormatError(`Workflow file is not valid JSON: ${reason}`);
  }
  if (data !== null && typeof data === 'object' && 'schemaVersion' in data && data.schemaVersion !== 1) {
    throw new WorkflowFormatError(`Workflow schemaVersion ${String(data.schemaVersion)} is not supported by this version of Vestigium.`);
  }
  return validateWorkflow(data);
}

export async function writeWorkflowFile(path: string, workflow: Workflow): Promise<void> {
  const text = serializeWorkflow(workflow);
  // Write-then-rename so a crash mid-write never leaves a truncated file in place of a good one.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readWorkflowFile(path: string): Promise<Workflow> {
  // Check size before reading so a huge file is rejected without loading it into memory.
  const info = await stat(path);
  if (!info.isFile()) throw new WorkflowFormatError('The selected path is not a file.');
  if (info.size > MAX_WORKFLOW_BYTES) {
    throw new WorkflowFormatError(`Workflow file is larger than ${MAX_WORKFLOW_BYTES / 1024 / 1024} MiB.`);
  }
  return parseWorkflow(await readFile(path, 'utf8'));
}
