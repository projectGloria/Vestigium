import type { PageEvent, RecorderCommand, RecorderResult } from '../shared/recorder.js';
import { installCapture } from './capture.js';
import { setRecording } from './highlight.js';
import { runCommand } from './resolve.js';
import { answerQuery } from './learn/index.js';
import { listContext } from './learn/items.js';
import type { RecorderQuery } from '../shared/learn.js';
import { isCaptchaFrame } from './learn/obstacles.js';

// The only seam between the recorder and its host. The Electron preload implements it with ipcRenderer;
// tests implement it with an in-page stub, so the same core runs in plain Chromium under Playwright.
export interface RecorderTransport {
  send(event: PageEvent): void;
  onArm(listener: (armed: boolean) => void): void;
  // Async: resolving may wait for the target to settle (see settle.ts).
  onCommand(listener: (command: RecorderCommand) => Promise<RecorderResult>): void;
  onQuery(listener: (query: RecorderQuery) => Promise<unknown>): void;
}

export function installRecorder(window: Window, transport: RecorderTransport) {
  // A captcha provider's frame gets no recorder at all: nothing in it is recorded, and no run can act in it.
  if (isCaptchaFrame(window.location)) return;
  const isTopFrame = window === window.top;
  // Item lists are learned in the top document only; framed lists are out of scope (see ARCHITECTURE.md).
  const capture = installCapture(window, event => transport.send(event), isTopFrame ? element => {
    try {
      return listContext(window.document, element);
    } catch {
      return null; // analysis must never cost the user their recorded click
    }
  } : undefined);
  transport.onArm(armed => {
    capture.setArmed(armed);
    // The overlay needs a document element; arming can arrive while the document is still empty.
    const apply = () => setRecording(window.document, armed, isTopFrame);
    if (window.document.documentElement) apply();
    else window.document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
  transport.onCommand(async command => {
    try {
      return await runCommand(window.document, command);
    } catch (error) {
      return { status: 'error', message: `Recorder failed: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  });
  transport.onQuery(query => answerQuery(window.document, query));
}
