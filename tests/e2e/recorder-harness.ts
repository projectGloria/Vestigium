// Test-only entry: bundled as an IIFE and injected into every frame with page.addInitScript.
// It runs the production recorder core with a stub transport in place of ipcRenderer.
import type { PageEvent, RecorderCommand, RecorderResult } from '../../src/shared/recorder.js';
import { installRecorder } from '../../src/recorder/core.js';
import { describeElement } from '../../src/recorder/capture.js';
import { resolveTarget } from '../../src/recorder/resolve.js';
import type { QueryResults, RecorderQuery } from '../../src/shared/learn.js';

export interface Harness {
  arm(armed: boolean): void;
  run(command: RecorderCommand): Promise<RecorderResult>;
  query<Q extends RecorderQuery>(query: Q): Promise<QueryResults[Q['kind']]>;
  // Locators for an element, located by CSS (inside an optional open shadow host) without user input.
  describe(selector: string, host?: string): ReturnType<typeof describeElement>;
  // Which element a command resolves to, as a short outerHTML snippet, or the failure result.
  resolved(command: Pick<RecorderCommand, 'locators' | 'shadowHosts'> & { heal?: boolean }): string | RecorderResult;
}

declare global {
  interface Window {
    __vestigium: Harness;
    // Exposed by the test with page.exposeBinding; survives navigations, unlike in-page arrays.
    __vestigiumSend?: (event: PageEvent) => void;
  }
}

let arm: (armed: boolean) => void = () => {};
let run: (command: RecorderCommand) => Promise<RecorderResult> = async () => ({ status: 'error', message: 'Recorder not installed.' });

let ask: (query: RecorderQuery) => Promise<unknown> = async () => null;

installRecorder(window, {
  send: event => window.__vestigiumSend?.(event),
  onArm: listener => { arm = listener; },
  onCommand: listener => { run = listener; },
  onQuery: listener => { ask = listener; },
});

window.__vestigium = {
  arm: armed => arm(armed),
  run: command => run(command),
  query: query => ask(query) as never,
  describe(selector, host) {
    const root = host ? document.querySelector(host)?.shadowRoot : document;
    const element = root?.querySelector(selector);
    if (!element) throw new Error(`No element for ${selector}`);
    return describeElement(element);
  },
  resolved(command) {
    const resolution = resolveTarget(document, command);
    return resolution.ok ? resolution.found.element.outerHTML.slice(0, 160) : resolution.result;
  },
};
