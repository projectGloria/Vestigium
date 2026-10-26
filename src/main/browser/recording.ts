import { ipcMain, type IpcMainEvent, type Session, type WebContents, type WebFrameMain } from 'electron';
import { RECORDER_CHANNELS, type RecordedEvent } from '../../shared/recorder.js';
import type { FrameRef } from '../../shared/types.js';
import { pageEventSchema } from '../engine/workflow-schema.js';
import { compileSteps, type CompileResult } from '../learn/step-compiler.js';
import { generalize } from '../learn/generalize.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { TabManager } from './tabs.js';
import type { DownloadRequest } from './session.js';

const PRELOAD_ID = 'vestigium-recorder';
// Recorders flush typed text and pending scrolls when disarmed; wait for those last messages before compiling.
const FLUSH_GRACE_MS = 250;
const MAX_EVENTS = 5000;

export interface RecordingStatus { active: boolean; events: number }
// `learned`: what generalization found (items, pagination), in plain language.
export interface RecordingResult extends CompileResult { startUrl: string | null; learned: string[] }

// Path of frames from the top document down to `frame`; empty for the main frame.
export function framePath(frame: WebFrameMain): FrameRef[] {
  const path: FrameRef[] = [];
  for (let current = frame; current.parent; current = current.parent) {
    const index = current.parent.frames.findIndex(sibling => sibling.frameTreeNodeId === current.frameTreeNodeId);
    path.unshift({ url: current.url, name: current.name, index: Math.max(index, 0) });
  }
  return path;
}

// Owns one recording at a time: arms the recorder preload in the recorded tab (and popups it opens),
// accepts validated page events only from those tabs, adds browser-side events, and compiles them to steps.
export class RecordingSession {
  private active = false;
  private events: RecordedEvent[] = [];
  // WebContents ID → tab alias ('main', 'popup-N'). Only these tabs are recorded.
  private aliases = new Map<number, string>();
  private popups = 0;
  private startUrl: string | null = null;
  private warned = { sensitive: false, invalid: false, full: false, captcha: false };

  constructor(private session: Session, private tabs: TabManager, private log: Logger, private changed: () => void, preloadPath: string) {
    session.registerPreloadScript({ type: 'frame', id: PRELOAD_ID, filePath: preloadPath });
    ipcMain.on(RECORDER_CHANNELS.ready, this.onReady);
    ipcMain.on(RECORDER_CHANNELS.event, this.onEvent);
  }

  status(): RecordingStatus {
    return { active: this.active, events: this.events.length };
  }

  start() {
    if (this.active) throw new UserFacingError('A recording is already running.');
    const contents = this.tabs.active();
    const url = contents.getURL();
    this.events = [];
    this.aliases = new Map([[contents.id, 'main']]);
    this.popups = 0;
    this.warned = { sensitive: false, invalid: false, full: false, captcha: false };
    this.startUrl = url && url !== 'about:blank' ? url : null;
    // The page that is open when recording starts is the workflow's starting point.
    if (this.startUrl) this.events.push({ kind: 'navigate', at: Date.now(), tab: 'main', url: this.startUrl, inPage: false, fromAddressBar: true });
    this.active = true;
    this.arm(contents, true);
    this.log.write('info', this.startUrl ? `Recording started on ${new URL(this.startUrl).host}.` : 'Recording started. Enter a URL to begin.');
    this.changed();
  }

  async stop(): Promise<RecordingResult> {
    if (!this.active) throw new UserFacingError('No recording is running.');
    for (const id of this.aliases.keys()) {
      const contents = this.tabs.get(id);
      if (contents) this.arm(contents, false);
    }
    await new Promise(resolve => setTimeout(resolve, FLUSH_GRACE_MS));
    this.active = false;
    const compiled = compileSteps(this.events);
    const general = generalize(compiled.steps, compiled.lists);
    const result = { ...compiled, steps: general.steps, startUrl: this.startUrl, learned: general.notes };
    this.log.write('info', `Recording stopped: ${this.events.length} events became ${compiled.steps.length} steps.`);
    for (const note of result.notes) this.log.write('warn', note);
    for (const note of result.learned) this.log.write('info', note);
    this.events = [];
    this.aliases.clear();
    this.changed();
    return result;
  }

  // ---------- browser-side observations (from TabManager and the session) ----------

  onNavigate(contents: WebContents, url: string, details: { inPage: boolean; fromAddressBar: boolean }) {
    const tab = this.tabOf(contents);
    if (tab) this.add({ kind: 'navigate', at: Date.now(), tab, url, ...details });
  }

  onPopup(popup: WebContents, opener: WebContents) {
    const tab = this.tabOf(opener);
    if (!tab) return;
    const alias = `popup-${++this.popups}`;
    this.aliases.set(popup.id, alias);
    this.add({ kind: 'popup', at: Date.now(), tab, popup: alias });
    // The popup's frames announce themselves with 'ready' as they load and get armed then.
  }

  onDownload(contents: WebContents, download: DownloadRequest) {
    const tab = this.tabOf(contents);
    if (tab) this.add({ kind: 'download', at: Date.now(), tab, url: download.url, filename: download.filename, mimeType: download.mimeType });
    return tab !== null;
  }

  dispose() {
    ipcMain.removeListener(RECORDER_CHANNELS.ready, this.onReady);
    ipcMain.removeListener(RECORDER_CHANNELS.event, this.onEvent);
    this.session.unregisterPreloadScript(PRELOAD_ID);
  }

  // ---------- recorder preload messages ----------

  private tabOf(contents: WebContents): string | null {
    return this.active ? this.aliases.get(contents.id) ?? null : null;
  }

  private arm(contents: WebContents, armed: boolean) {
    if (contents.isDestroyed()) return;
    for (const frame of contents.mainFrame.framesInSubtree) {
      // A frame without the preload yet simply drops this; it will send 'ready' once loaded.
      if (!frame.isDestroyed()) frame.send(RECORDER_CHANNELS.arm, armed);
    }
  }

  private onReady = (event: IpcMainEvent) => {
    if (this.tabOf(event.sender) && event.senderFrame && !event.senderFrame.isDestroyed()) {
      event.senderFrame.send(RECORDER_CHANNELS.arm, true);
    }
  };

  private onEvent = (event: IpcMainEvent, payload: unknown) => {
    // Only managed, recorded tabs; everything else (other tabs, the shell, stale frames) is ignored silently.
    const tab = this.tabOf(event.sender);
    if (!tab || !this.tabs.get(event.sender.id) || !event.senderFrame) return;
    const parsed = pageEventSchema.safeParse(payload);
    if (!parsed.success) {
      if (!this.warned.invalid) this.log.write('warn', 'Ignored a malformed recorder message from a page.');
      this.warned.invalid = true;
      return;
    }
    if (parsed.data.kind === 'sensitive') {
      if (!this.warned.sensitive) this.log.write('info', 'Skipped a password or payment field; nothing typed into it was recorded.');
      this.warned.sensitive = true;
    }
    if (parsed.data.kind === 'captcha') {
      if (!this.warned.captcha) this.log.write('info', 'You solved a captcha; it is not recorded. Runs will pause there and wait for you.');
      this.warned.captcha = true;
    }
    // Tab, frame path and time come from main's own view of the sender, never from the page.
    this.add({ ...parsed.data, at: Date.now(), tab, frames: framePath(event.senderFrame) });
  };

  private add(event: RecordedEvent) {
    if (this.events.length >= MAX_EVENTS) {
      if (!this.warned.full) this.log.write('warn', `Recording reached ${MAX_EVENTS} events; further input is ignored. Stop and save it.`);
      this.warned.full = true;
      return;
    }
    this.events.push(event);
    this.changed();
  }
}
