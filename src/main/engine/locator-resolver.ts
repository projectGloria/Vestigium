import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainEvent, type WebContents, type WebFrameMain } from 'electron';
import { z } from 'zod';
import { RECORDER_CHANNELS, type RecorderCommand, type RecorderResult } from '../../shared/recorder.js';
import type { FrameRef } from '../../shared/types.js';
import { matchFrame } from './frame-match.js';
import { foundItemsSchema, locatorSchema, paginationReportSchema } from './workflow-schema.js';
import type { QueryResults, RecorderQuery } from '../../shared/learn.js';

// Sends replay commands to the recorder preload in a specific frame and waits for that frame's answer.
// Element lookup happens in the page (the only place the DOM exists); this side picks the frame and
// treats everything coming back as untrusted input.

export type BridgeResult = RecorderResult | { status: 'unavailable'; message: string };

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('done'), strategy: z.enum(['role', 'text', 'testid', 'css', 'xpath', 'fingerprint', 'window', 'healed']),
    value: z.string().max(4096),
    point: z.strictObject({ x: coordinate, y: coordinate }).optional(),
    // Pages may only *propose* locators; they are schema-checked again when the workflow is saved.
    refreshed: z.array(locatorSchema).min(1).max(12).optional(),
    healed: z.string().max(1000).optional(),
    banner: z.string().max(200).optional(),
  }),
  z.strictObject({ status: z.literal('not-found'), message: z.string().max(1000) }),
  z.strictObject({ status: z.literal('not-ready'), message: z.string().max(1000) }),
  z.strictObject({ status: z.literal('error'), message: z.string().max(1000) }),
]);
const messageSchema = z.strictObject({ id: z.string().uuid(), result: z.unknown() });

// A frame's identity for matching replies: same process and same document-level frame token.
const keyOf = (frame: WebFrameMain) => `${frame.processId}:${frame.frameToken}`;

export function findFrame(contents: WebContents, path: FrameRef[]): WebFrameMain | null {
  let frame: WebFrameMain = contents.mainFrame;
  for (const ref of path) {
    const children = frame.frames.filter(child => !child.isDestroyed() && !child.detached);
    const index = matchFrame(children.map(child => ({ url: child.url, name: child.name })), ref);
    if (index === null) return null;
    frame = children[index];
  }
  return frame;
}

// Strict shapes for query answers. Page analysis is untrusted input like everything else from a page.
const httpUrl = z.string().max(8192).regex(/^https?:\/\//);
const querySchemas: { [K in RecorderQuery['kind']]: z.ZodType<QueryResults[K]> } = {
  'analyze-pagination': paginationReportSchema,
  signature: z.strictObject({ hash: z.string().regex(/^[0-9a-f]{8}$/), links: z.array(httpUrl).max(2000) }),
  'control-state': z.strictObject({ state: z.enum(['enabled', 'disabled', 'missing']) }),
  'scroll-probe': z.strictObject({ before: z.number().int().min(0), after: z.number().int().min(0) }),
  'find-items': foundItemsSchema,
  'extract-metadata': z.strictObject({
    url: httpUrl, title: z.string().max(300), tags: z.array(z.string().max(200)).max(100), date: z.string().max(100).nullable(),
    fields: z.array(z.strictObject({ label: z.string().min(1).max(100), value: z.string().min(1).max(1000) })).max(50),
  }),
  obstacles: z.strictObject({ captcha: z.string().max(200).nullable(), login: z.boolean(), countdown: z.string().max(200).nullable() }),
};

export type QueryAnswer<K extends RecorderQuery['kind']> = { ok: true; value: QueryResults[K] } | { ok: false; message: string };

export class FrameCommandBridge {
  private pending = new Map<string, { frame: string; resolve: (raw: unknown) => void }>();

  constructor() {
    ipcMain.on(RECORDER_CHANNELS.result, this.onResult);
  }

  dispose() {
    ipcMain.removeListener(RECORDER_CHANNELS.result, this.onResult);
    for (const { resolve } of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  // 'unavailable' means the frame is missing, not ready (no recorder loaded yet), or did not answer in time.
  // All three are worth retrying while the step still has time.
  async send(contents: WebContents, path: FrameRef[], command: RecorderCommand, timeoutMs: number): Promise<BridgeResult> {
    const raw = await this.request(contents, path, RECORDER_CHANNELS.command, { command }, timeoutMs);
    if (typeof raw === 'string') return { status: 'unavailable', message: raw };
    const result = resultSchema.safeParse(raw.value);
    return result.success ? result.data : { status: 'error', message: 'The page returned an invalid replay result.' };
  }

  async query<Q extends RecorderQuery>(contents: WebContents, path: FrameRef[], query: Q, timeoutMs: number): Promise<QueryAnswer<Q['kind']>> {
    const raw = await this.request(contents, path, RECORDER_CHANNELS.query, { query }, timeoutMs);
    if (typeof raw === 'string') return { ok: false, message: raw };
    const schema = querySchemas[query.kind] as z.ZodType<QueryResults[Q['kind']]>;
    const result = schema.safeParse(raw.value);
    return result.success ? { ok: true, value: result.data } : { ok: false, message: 'The page returned an invalid analysis result.' };
  }

  // Resolves with the frame's raw answer, or a string explaining why there is none.
  private request(contents: WebContents, path: FrameRef[], channel: string, body: object, timeoutMs: number): Promise<{ value: unknown } | string> {
    if (contents.isDestroyed()) return Promise.resolve('The tab was closed.');
    const frame = findFrame(contents, path);
    if (!frame) return Promise.resolve(path.length ? 'The recorded frame was not found on the page.' : 'The page is not ready.');
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve('The page did not respond; it may still be loading.');
      }, timeoutMs);
      this.pending.set(id, {
        frame: keyOf(frame),
        resolve: raw => {
          clearTimeout(timer);
          resolve(raw === undefined ? 'Replay stopped.' : { value: raw });
        },
      });
      frame.send(channel, { id, ...body });
    });
  }

  private onResult = (event: IpcMainEvent, payload: unknown) => {
    const message = messageSchema.safeParse(payload);
    if (!message.success) return;
    const pending = this.pending.get(message.data.id);
    // A reply only counts from the exact frame the request was sent to; IDs are unguessable but not secret to that frame.
    if (!pending || !event.senderFrame || keyOf(event.senderFrame) !== pending.frame) return;
    this.pending.delete(message.data.id);
    pending.resolve(message.data.result ?? null);
  };
}
