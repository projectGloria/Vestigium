import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Command, Payloads } from '../shared/ipc.js';
export function isBrowserUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export const urlSchema = z.string().min(1).max(8192).refine(isBrowserUrl, 'Use an HTTP or HTTPS URL without embedded credentials.');
export const boundsSchema = z.object({ x: z.number().int().min(-100000).max(100000).optional(), y: z.number().int().min(-100000).max(100000).optional(), width: z.number().int().min(900).max(10000), height: z.number().int().min(640).max(10000) }).strict();
const delay = z.number().int().min(0).max(60_000);
export const runSettingsSchema = z.object({ stepDelayMinMs: delay, stepDelayMaxMs: delay, hostIntervalMs: delay }).strict()
  .refine(value => value.stepDelayMinMs <= value.stepDelayMaxMs, 'The minimum delay cannot exceed the maximum.');
// '' = the default folder. A chosen folder must be absolute; it comes from the native folder dialog in main.
// A template is a relative path of {tokens} and text: no drive, no root, no "..", no characters Windows forbids.
export const templateSchema = z.string().trim().min(1).max(300)
  .refine(value => !/[<>:"\\|?*]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => part.trim() === '..'),
    'Use a relative path like {site}/{tag}/{title}.{ext}, without .. or the characters < > : " \\ | ? *.');
export const downloadSettingsSchema = z.object({
  directory: z.string().max(1024).refine(value => value === '' || isAbsolute(value), 'Choose an absolute folder.'),
  concurrency: z.number().int().min(1).max(6), retries: z.number().int().min(0).max(10), force: z.boolean(),
  template: templateSchema, sidecar: z.boolean(), extract: z.enum(['off', 'keep', 'delete']),
}).strict();
export const metadataSettingsSchema = z.object({ labels: z.array(z.string().trim().min(1).max(60)).max(50) }).strict();
// Hosts like "example.com" or "files.example.com:8080"; a leading "*." allows every subdomain.
const hostPattern = z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/, 'Use a site name like example.com or *.example.com.');
export const safetySettingsSchema = z.object({ allowlist: z.array(hostPattern).max(200), confirmRisky: z.boolean() }).strict();
export const traySettingsSchema = z.object({ minimizeToTray: z.boolean() }).strict();
export const adblockSettingsSchema = z.object({ enabled: z.boolean() }).strict();
export const settingSchemas = { theme: z.enum(['light', 'dark']), lastUrl: urlSchema, windowBounds: boundsSchema, run: runSettingsSchema, downloads: downloadSettingsSchema, metadata: metadataSettingsSchema,
  safety: safetySettingsSchema, tray: traySettingsSchema, adblock: adblockSettingsSchema };
const empty = z.undefined();
const workflowId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const workflowRef = z.object({ id: workflowId }).strict();
const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const workflowChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('relabel'), stepId, label: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('toggle'), stepId, enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('move'), stepId, direction: z.enum(['up', 'down']) }).strict(),
  z.object({ kind: z.literal('delete-step'), stepId }).strict(),
  z.object({ kind: z.literal('accept-review'), stepId }).strict(),
  z.object({ kind: z.literal('revert-review'), stepId }).strict(),
  z.object({ kind: z.literal('set-max-pages'), stepId, maxPages: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal('exclude-item'), stepId, url: urlSchema, excluded: z.boolean() }).strict(),
  z.object({ kind: z.literal('set-max-items'), stepId, maxItems: z.number().int().min(1).max(100_000) }).strict(),
]);
const id = z.object({ id: z.number().int().positive() }).strict();
const schemas = { state: empty, navigate: z.object({ url: urlSchema }).strict(), back: empty, forward: empty, reload: empty, newTab: empty, selectTab: id, closeTab: id, theme: z.object({ theme: settingSchemas.theme }).strict(), recordStart: empty, recordStop: empty,
  workflowRun: z.object({ id: workflowId, mode: z.enum(['run', 'step', 'dry']) }).strict(), runStop: empty,
  runPause: empty, runResume: empty, runNext: empty, runSettings: runSettingsSchema, workflowSelect: workflowRef, workflowDelete: workflowRef, workflowExport: workflowRef,
  workflowUpdate: z.object({ id: workflowId, version: z.number().int().min(1), change: workflowChange }).strict(), workflowImport: empty,
  workflowLearnPages: z.object({ id: workflowId, version: z.number().int().min(1) }).strict(),
  workflowPreviewItems: z.object({ id: workflowId, stepId, show: z.boolean() }).strict(),
  downloadControl: z.object({ action: z.enum(['pause', 'resume', 'cancel', 'retry']), id: workflowId.nullable() }).strict(),
  downloadSettings: downloadSettingsSchema.omit({ directory: true }), downloadFolderChoose: empty, downloadFolderOpen: empty,
  downloadShow: z.object({ id: workflowId }).strict(), metadataLabels: metadataSettingsSchema,
  profileStart: z.object({ url: urlSchema.nullable() }).strict(), profileDelete: workflowRef,
  workflowReteach: z.object({ id: workflowId, stepId }).strict(),
  // Screenshot names are UUIDs from main; anything else (a path, "..") is refused before touching the filesystem.
  screenshotOpen: z.object({ name: z.string().regex(/^[0-9a-f-]{36}\.png$/) }).strict(), clipboardDismiss: empty,
  safetySettings: safetySettingsSchema, traySettings: traySettingsSchema, adblockSettings: adblockSettingsSchema };
export function validatePayload<K extends Command>(command: K, value: unknown): Payloads[K] {
  return schemas[command].parse(value) as Payloads[K];
}
