import { ipcRenderer } from 'electron';
import { RECORDER_CHANNELS, type RecorderCommand, type RecorderResult } from '../shared/recorder.js';
import { installRecorder } from './core.js';
import type { RecorderQuery } from '../shared/learn.js';

// Session-registered frame preload for browser tabs. It runs in Electron's isolated world in every frame
// (including cross-origin iframes) and exposes nothing to the page: no contextBridge, no globals.
// Main validates every message it sends; this side only trusts main.

installRecorder(window, {
  send: event => ipcRenderer.send(RECORDER_CHANNELS.event, event),
  onArm: listener => {
    ipcRenderer.on(RECORDER_CHANNELS.arm, (_event, armed: unknown) => listener(armed === true));
  },
  onCommand: listener => {
    ipcRenderer.on(RECORDER_CHANNELS.command, async (_event, message: { id: string; command: RecorderCommand }) => {
      let result: RecorderResult;
      try {
        result = await listener(message.command);
      } catch (error) {
        result = { status: 'error', message: error instanceof Error ? error.message : 'Recorder command failed.' };
      }
      ipcRenderer.send(RECORDER_CHANNELS.result, { id: message.id, result });
    });
  },
  onQuery: listener => {
    ipcRenderer.on(RECORDER_CHANNELS.query, async (_event, message: { id: string; query: RecorderQuery }) => {
      let result: unknown;
      try {
        result = await listener(message.query);
      } catch {
        result = null; // main treats an invalid answer as "no answer"
      }
      ipcRenderer.send(RECORDER_CHANNELS.result, { id: message.id, result });
    });
  },
});

// Lets main arm frames that load while a recording is already running.
ipcRenderer.send(RECORDER_CHANNELS.ready);
