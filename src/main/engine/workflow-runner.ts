import type { WebContents } from 'electron';
import type { RecorderCommand, RecorderResult } from '../../shared/recorder.js';
import {
  RECORDABLE_STEP_TYPES, type Locator, type RunMode, type RunSettings, type RunState, type Step, type StepRunResult, type Workflow,
} from '../../shared/types.js';
import type { TabManager } from '../browser/tabs.js';
import type { DownloadRequest } from '../browser/session.js';
import type { NetworkMonitor } from '../browser/network.js';
import type { Logger } from '../logger.js';
import { UserFacingError } from '../errors.js';
import { isBrowserUrl } from '../validation.js';
import type { FrameCommandBridge } from './locator-resolver.js';
import type { QueryResults, RecorderQuery } from '../../shared/learn.js';
import type { DownloadJob, DownloadOrigin, SafetySettings } from '../../shared/types.js';
import { findStep } from './steps.js';
import { detailLabels, toItemMetadata } from '../learn/metadata.js';

// What the runner needs from the download queue: skip items already downloaded, and record what happened to an item
// whose page produced no download (missing or dead link, an error page).
export interface RunDownloads {
  isItemDone(url: string): boolean;
  markItem(item: { url: string; title: string; sourcePage: string; metadata?: Record<string, string> }, status: 'pending' | 'failed' | 'no_download'): void;
  // Labels whose values are read from every item page (milestone 7): password, author, tags …
  metadataLabels(): string[];
}
// Where a download came from, so the queue can tie it to its item and re-resolve it later.
export interface DownloadContext { item: { url: string; title: string; sourcePage: string } | null; origin: DownloadOrigin }

// Replays a workflow step by step in the active tab (alias "main") and the popups its steps open.
//
// Per step: polite delay (random + per-host interval) → network idle (best effort) → resolve in the page (ranked
// locators, then fuzzy healing; the page waits for the element to settle and clears consent banners) → act
// (trusted OS-level click in the main frame, synthetic input inside iframes) → wait for the step's effects.
// Modes: run, step (pause before every step), dry (find and highlight only). Pause/Resume/Next/Stop at any time.
// A step with onFail "pause" pauses for the user and retries on Resume (human-in-the-loop).
// Loops: a page loop runs its body on every page of the list; an item loop opens every item of the current list page
// in a dedicated "item" tab (the list tab keeps its place, which matters for load-more and SPA lists) and runs its
// body there. One failing item is reported and skipped; it never stops the other items.

// Each command round trip is short: a frame that has not loaded its recorder yet never answers,
// and polling again soon is cheaper than one long wait. The page side may spend up to ~1.2 s settling.
const ATTEMPT_TIMEOUT_MS = 3000;
// Waiting for an effect of an action (page change, popup, download) gets its own budget, independent of how
// long the element took to appear; otherwise a slow-to-appear button would leave no time for its download.
const EFFECT_TIMEOUT_MS = 15_000;
const ACTION_RETRIES = 2;
// A target that stays disabled this long is waiting for a countdown or a person, not for the page to settle.
const HUMAN_PATIENCE_MS = 2500;
// How long a run waits for a person (captcha, login, countdown) before that step fails.
const HUMAN_WAIT_MS = 15 * 60_000;
// Plan §7: a click whose target reads like this waits for your OK first (buy, pay, delete, unsubscribe…, also in
// Turkish, Spanish, French and German). Unicode letter boundaries, because \b only knows ASCII ("öde", "sil").
const RISKY = /(?<![\p{L}\p{N}])(buy|purchase|checkout|check out|pay|payment|place order|order now|subscribe|unsubscribe|delete|remove|erase|destroy|cancel (my )?(account|subscription|order)|confirm (payment|purchase|order)|satın al|öde|sil|comprar|pagar|eliminar|borrar|acheter|payer|supprimer|kaufen|bezahlen|löschen)(?![\p{L}\p{N}])/iu;
const IDLE_QUIET_MS = 400;
const IDLE_LIMIT_MS = 4000;

class StepFailure extends Error {
  // retryable: nothing happened yet (element missing/not ready, page not answering); safe to try again.
  // final: the action ran and its outcome is definite (a download link that leads to an error page); repeating the
  // action cannot help, because the page it needs is gone, so onFail "retry" does not apply either.
  // cause: what the page said, when it answered: the target is missing, or there but disabled/covered.
  constructor(message: string, readonly retryable: boolean, readonly final = false, readonly cause: 'not-found' | 'not-ready' | null = null) {
    super(message);
  }
}

// Why a run waits for a person, and what to tell them.
interface PersonWait { kind: 'captcha' | 'login' | 'countdown'; message: string }

class Stopped extends Error {}

type BrowserSignal =
  | { kind: 'navigate'; contents: WebContents; inPage: boolean; status: number }
  | { kind: 'popup'; popup: WebContents; opener: WebContents }
  | { kind: 'download'; contents: WebContents; download: DownloadRequest };

interface Waiter<T> { promise: Promise<T>; cancel(): void }

// Called when a step only succeeded through a fallback or a heal: the workflow should learn the new locators.
export type HealHandler = (workflowId: string, stepId: string, locators: Locator[], reason: string) => void;

interface Outcome { ok: true; locator: string | null; message: string }
interface Failure { ok: false; message: string }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Stopped());
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Stopped());
  };
  signal.addEventListener('abort', onAbort, { once: true });
});

// Rejects with Stopped as soon as the run is stopped; removes its listener either way (no per-step leaks).
function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped());
    const onAbort = () => reject(new Stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export class WorkflowRunner {
  private state: RunState | null = null;
  private controller: AbortController | null = null;
  private aliases = new Map<string, WebContents>();
  private listeners = new Set<(signal: BrowserSignal) => void>();
  // Pause machinery: `pauseRequested` takes effect at the next checkpoint; `release` ends the current pause.
  private pauseRequested = false;
  private release: ((how: 'resume' | 'next') => void) | null = null;
  private stepBudget = 0; // steps allowed before the next automatic pause (step mode)
  private lastStepAt = new Map<string, number>(); // host → time of the last step there
  // Item loops: item URLs already opened in this run (per loop step), so items repeated across pages run once.
  private seenItems = new Map<string, Set<string>>();
  private itemLimitHit = false;
  // Logged once per run: clicks while the window is minimized are performed in-page (see act).
  private hiddenNoted = false;
  private pageLabel: string | null = null; // "Page 3" while a page loop runs, for the progress line
  // Called when the run needs a person: the app brings its window forward (plan §4) and may notify.
  onAttention: ((contents: WebContents, message: string) => void) | null = null;
  // Called once a run has ended (history, site profile health).
  onFinished: ((run: RunState) => void) | null = null;
  // The current (or last) run's execute(); settles once the run has ended and onFinished has run.
  private running: Promise<void> = Promise.resolve();
  // Saves a failure screenshot (PNG) and returns its file name.
  saveScreenshot: ((png: Buffer) => Promise<string | null>) | null = null;
  // Plan §7: which sites a run may use, and whether risky-looking clicks wait for your OK.
  safety: () => SafetySettings = () => ({ allowlist: [], confirmRisky: false });
  // Sites and risky steps you allowed during this run (asked once each).
  private allowedHosts = new Set<string>();
  private allowedSteps = new Set<string>();
  // The item an item loop is working on and the step being executed: downloads they cause are attributed to them.
  private currentItem: { url: string; title: string; sourcePage: string; loopStepId: string } | null = null;
  private currentStepId: string | null = null;
  // The step that ended the latest failed sequence (an item whose download step failed has no download).
  private lastFailed: Step | null = null;
  // While a link is being renewed (see renew), downloads go to the waiting job instead of the queue.
  private renewal: { resolve(url: string): void } | null = null;
  private workflowId: string | null = null;

  constructor(
    private tabs: TabManager, private bridge: FrameCommandBridge, private network: NetworkMonitor, private log: Logger,
    private changed: () => void, private settings: () => RunSettings, private onHeal: HealHandler,
    private downloads: RunDownloads | null = null,
  ) {}

  status(): RunState | null {
    return this.state;
  }

  // Running or paused: the run still owns its tabs and its workflow.
  isRunning(): boolean {
    return this.state?.status === 'running' || this.state?.status === 'paused';
  }

  // `tab`: run in this tab instead of the active one (link renewal uses a tab of its own).
  start(workflow: Workflow, mode: RunMode = 'run', tab?: WebContents) {
    if (this.isRunning()) throw new UserFacingError('A workflow is already running. Stop it first.');
    if (workflow.steps.filter(step => step.enabled).length === 0) throw new UserFacingError('This workflow has no enabled steps.');
    const controller = new AbortController();
    this.controller = controller;
    this.aliases = new Map([['main', tab ?? this.tabs.active()]]);
    this.workflowId = workflow.id;
    this.currentItem = null;
    this.currentStepId = null;
    this.lastFailed = null;
    this.allowedHosts = new Set();
    this.allowedSteps = new Set();
    this.pauseRequested = false;
    this.stepBudget = 0;
    this.seenItems = new Map();
    this.itemLimitHit = false;
    this.hiddenNoted = false;
    this.pageLabel = null;
    this.state = {
      workflowId: workflow.id, workflowName: workflow.name, mode, status: 'running', current: null, total: workflow.steps.length,
      results: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, pauseReason: null, progress: null, waitingFor: null,
      failure: null,
    };
    const verb = mode === 'dry' ? 'Dry-running' : mode === 'step' ? 'Stepping through' : 'Running';
    this.log.write('info', `${verb} "${workflow.name}" (${workflow.steps.length} steps).`);
    // A private copy: heals update it as the run goes, without touching the caller's object.
    // execute() never rejects (its errors end the run); the promise is kept so shutdown can wait for the run's end.
    this.running = this.execute(structuredClone(workflow), controller.signal);
    this.changed();
  }

  stop() {
    if (!this.isRunning()) throw new UserFacingError('No workflow is running.');
    this.controller?.abort();
  }

  // For shutdown: stops a run and waits until it has ended and reported (onFinished writes the history), so that
  // happens before the database closes. Bounded: a run stuck in a page command must not keep the app from quitting.
  async stopAndSettle(limitMs: number): Promise<void> {
    if (this.isRunning()) this.controller?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.running, new Promise<void>(resolve => { timer = setTimeout(resolve, limitMs); })]);
    clearTimeout(timer);
  }

  pause() {
    if (this.state?.status !== 'running') throw new UserFacingError('The run is not running.');
    this.pauseRequested = true;
    this.log.write('info', 'Pause requested; the run pauses before its next step.');
    this.changed();
  }

  // Continue normally (leaves step mode too). In a paused failure, the failed step is retried first.
  resume() {
    if (this.state?.status !== 'paused' || !this.release) throw new UserFacingError('The run is not paused.');
    this.release('resume');
  }

  // Run exactly one more step, then pause again.
  next() {
    if (this.state?.status !== 'paused' || !this.release) throw new UserFacingError('The run is not paused.');
    this.release('next');
  }

  // ---------- browser signals (forwarded from TabManager and the session) ----------

  onNavigate(contents: WebContents, details: { inPage: boolean; status: number }) {
    this.emit({ kind: 'navigate', contents, inPage: details.inPage, status: details.status });
  }

  onPopup(popup: WebContents, opener: WebContents) {
    this.emit({ kind: 'popup', popup, opener });
  }

  onDownload(contents: WebContents, download: DownloadRequest) {
    this.emit({ kind: 'download', contents, download });
  }

  // For a download from one of this run's tabs: which item and step caused it. Null for other tabs (manual downloads).
  downloadContext(contents: WebContents): DownloadContext | null {
    if (!this.isRunning() || !this.workflowId || !this.currentStepId || ![...this.aliases.values()].includes(contents)) return null;
    const item = this.currentItem;
    return {
      item: item ? { url: item.url, title: item.title, sourcePage: item.sourcePage } : null,
      origin: { workflowId: this.workflowId, stepId: this.currentStepId, loopStepId: item?.loopStepId ?? null },
    };
  }

  // A download while a link is being renewed belongs to the waiting job: true means "handled, do not queue it".
  claimRenewal(contents: WebContents, download: DownloadRequest): boolean {
    if (!this.renewal || !this.isRunning() || ![...this.aliases.values()].includes(contents)) return false;
    this.renewal.resolve(download.url);
    return true;
  }

  // Renews an expired download link by redoing what produced it, in a tab of its own: the item page is opened again and
  // the item loop's body (or the single download step) runs once, and the fresh URL of the resulting download is
  // returned. Only while no other run is active (one runner drives the tabs); otherwise null, and the job fails with
  // its "expired" message until Retry.
  async renew(workflow: Workflow, job: DownloadJob): Promise<string | null> {
    if (this.isRunning() || !job.origin || !job.sourcePage) return null;
    const located = findStep(workflow.steps, job.origin.stepId);
    if (!located) return null;
    const loop = job.origin.loopStepId ? findStep(workflow.steps, job.origin.loopStepId)?.step : null;
    const body = loop?.type === 'loop_items' ? loop.params.steps : [located.step];
    // The item tab of the original run is "main" here: retarget so the steps act in the renewal tab.
    const retarget = (step: Step): Step => ({ ...structuredClone(step), target: { ...step.target, tab: step.target.tab === 'item' ? 'main' : step.target.tab } });
    const steps: Step[] = [
      { id: 'renew-open', type: 'navigate', label: `Open ${job.sourcePage}`, enabled: true, locators: [], params: { url: job.sourcePage },
        target: { tab: 'main', frames: [], shadowHosts: [] }, waitFor: null, timeoutMs: 30_000, onFail: 'abort' },
      ...body.map(retarget),
    ];
    const tab = this.tabs.create('about:blank').webContents;
    const fresh = new Promise<string>(resolve => { this.renewal = { resolve }; });
    try {
      this.start({ ...workflow, name: `Renewing the link of "${job.filename}"`, steps }, 'run', tab);
      const done = new Promise<null>(resolve => {
        const check = () => (this.isRunning() ? setTimeout(check, 200) : resolve(null));
        check();
      });
      return await Promise.race([fresh, done]);
    } finally {
      this.renewal = null;
      if (this.isRunning()) this.stop();
      if (!tab.isDestroyed()) this.tabs.close(tab.id);
    }
  }

  private emit(signal: BrowserSignal) {
    if (!this.isRunning()) return;
    for (const listener of [...this.listeners]) listener(signal);
  }

  // Starts listening immediately (before the action that causes the signal), resolves on the first match.
  private waitFor<T>(match: (signal: BrowserSignal) => T | undefined, timeoutMs: number, failure: string): Waiter<T> {
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      const listener = (signal: BrowserSignal) => {
        const value = match(signal);
        if (value === undefined) return;
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new StepFailure(failure, false));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      cancel = cleanup;
      this.listeners.add(listener);
    });
    // Waiters cancelled after a failed action are never awaited; keep their timeouts from surfacing as unhandled.
    promise.catch(() => {});
    return { promise, cancel: () => cancel() };
  }

  // ---------- pausing ----------

  // Does the page need a person? A captcha or a login form always does; a target that has stayed disabled past
  // HUMAN_PATIENCE_MS is waiting for a countdown or a confirmation. Asked only about the step's own page.
  private async needsPerson(step: Step, failure: StepFailure, waitedMs: number): Promise<PersonWait | null> {
    const contents = this.aliases.get(step.target.tab);
    if (!contents || contents.isDestroyed() || step.type === 'navigate' || step.type === 'wait') return null;
    const answer = await this.bridge.query(contents, [], { kind: 'obstacles' }, 1500);
    if (!answer.ok) return null;
    const found = answer.value;
    if (found.captcha) return { kind: 'captcha', message: `Solve ${found.captcha} in the page.` };
    if (found.login && failure.cause === 'not-found') return { kind: 'login', message: 'The site wants you to sign in. Sign in in the page.' };
    if (failure.cause === 'not-ready' && waitedMs >= HUMAN_PATIENCE_MS) {
      return { kind: 'countdown', message: found.countdown ? `The page says "${found.countdown}"; "${step.label}" waits until it is ready.` : `"${step.label}" is not available yet; it may need you to confirm something in the page.` };
    }
    return null;
  }

  // Pauses until the page is ready again (checked every second: no captcha, no login form, the target found and
  // enabled) or until the user presses Resume; then the step runs from the start. The window comes forward and the
  // target is highlighted, so the person sees what to do.
  private async waitForPerson(step: Step, wait: PersonWait, signal: AbortSignal) {
    const state = this.state!;
    const contents = this.tab(step.target.tab);
    state.waitingFor = wait.kind;
    this.log.write('warn', `Needs you: ${wait.message}`);
    try {
      this.tabs.select(contents.id);
    } catch { /* not a managed tab */ }
    this.onAttention?.(contents, wait.message);
    void this.preview(step);
    const ready = async () => {
      if (contents.isDestroyed()) return false;
      const page = await this.bridge.query(contents, [], { kind: 'obstacles' }, 1500);
      if (!page.ok || page.value.captcha || (page.value.login && wait.kind !== 'countdown')) return false;
      const found = await this.bridge.send(contents, step.target.frames, { ...this.base(step), action: { kind: 'none' }, highlight: false, heal: true }, 1500);
      return found.status === 'done';
    };
    try {
      const how = await this.pauseUntil(`Needs you: ${wait.message} The run continues by itself once that is done.`, signal, ready, HUMAN_WAIT_MS);
      if (how === 'timeout') throw new StepFailure(`Waited ${HUMAN_WAIT_MS / 60_000} minutes for you: ${wait.message}`, false, true);
      this.log.write('info', how === 'auto' ? `Continuing: the page is ready again (${wait.kind}).` : 'Continuing: you pressed Resume.');
    } finally {
      state.waitingFor = null;
    }
  }

  // Like pauseHere, but it also ends by itself when `ready()` turns true (polled every second) or after `limitMs`.
  private async pauseUntil(reason: string, signal: AbortSignal, ready: () => Promise<boolean>, limitMs: number): Promise<'resume' | 'next' | 'auto' | 'timeout'> {
    const state = this.state!;
    state.status = 'paused';
    state.pauseReason = reason;
    this.pauseRequested = false;
    this.changed();
    let polling = true;
    const manual = new Promise<'resume' | 'next'>(resolve => { this.release = resolve; });
    const automatic = (async (): Promise<'auto' | 'timeout'> => {
      const end = Date.now() + limitMs;
      while (polling) {
        await sleep(1000, signal);
        if (!polling) break;
        if (await ready().catch(() => false)) return 'auto';
        if (Date.now() > end) return 'timeout';
      }
      return 'timeout';
    })();
    automatic.catch(() => {}); // a stop rejects it; untilStopped reports the stop
    try {
      return await untilStopped(Promise.race([manual, automatic]), signal);
    } finally {
      polling = false;
      this.release = null;
      if (state.status === 'paused') {
        state.status = 'running';
        state.pauseReason = null;
        this.changed();
      }
    }
  }

  private async pauseHere(reason: string, signal: AbortSignal): Promise<'resume' | 'next'> {
    const state = this.state!;
    state.status = 'paused';
    state.pauseReason = reason;
    this.pauseRequested = false;
    this.changed();
    try {
      return await untilStopped(new Promise<'resume' | 'next'>(resolve => { this.release = resolve; }), signal);
    } finally {
      this.release = null;
      if (state.status === 'paused') {
        state.status = 'running';
        state.pauseReason = null;
        this.changed();
      }
    }
  }

  // Before each step: honour a pause request, and in step mode stop before every step once its budget is spent.
  private async checkpoint(step: Step, index: number, total: number, signal: AbortSignal, prefix = '') {
    const state = this.state!;
    const stepMode = state.mode === 'step';
    if (!this.pauseRequested && !(stepMode && this.stepBudget === 0)) {
      if (this.stepBudget > 0) this.stepBudget--;
      return;
    }
    const reason = this.pauseRequested ? `Paused by you before ${prefix}step ${index + 1}/${total}: ${step.label}` : `Next: ${prefix}step ${index + 1}/${total}: ${step.label}`;
    // Show where the next step will act, without acting.
    if (step.type !== 'navigate' && step.type !== 'wait' && step.locators.length) void this.preview(step);
    const how = await this.pauseHere(reason, signal);
    if (how === 'resume') state.mode = state.mode === 'step' ? 'run' : state.mode;
    else this.stepBudget = 0;
  }

  private async preview(step: Step) {
    const contents = this.aliases.get(step.target.tab);
    if (!contents || contents.isDestroyed()) return;
    await this.bridge.send(contents, step.target.frames, { ...this.base(step), action: { kind: 'none' }, heal: false }, ATTEMPT_TIMEOUT_MS);
  }

  // ---------- execution ----------

  private async execute(workflow: Workflow, signal: AbortSignal) {
    const state = this.state!;
    try {
      await this.runSequence(workflow, workflow.steps, signal, { top: true, prefix: '' });
      state.status = 'done';
      this.log.write('info', `Finished "${workflow.name}": all ${workflow.steps.length} steps processed.`);
    } catch (error) {
      if (error instanceof Stopped) {
        state.status = 'stopped';
        state.error = 'Stopped by you.';
        this.log.write('info', `Stopped "${workflow.name}".`);
      } else {
        state.status = 'failed';
        state.error = error instanceof Error ? error.message : 'The run failed unexpectedly.';
        this.log.write('error', state.error);
      }
    } finally {
      state.current = null;
      state.pauseReason = null;
      state.progress = null;
      state.finishedAt = new Date().toISOString();
      state.waitingFor = null;
      this.listeners.clear();
      this.controller = null;
      try {
        this.onFinished?.(state);
      } catch (error) {
        this.log.write('error', `The run could not be saved to the history: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      this.changed();
    }
  }

  // Runs a list of steps: the workflow's top level, or a loop body once per page. `prefix` ("Page 3 › ") marks
  // results and log lines from a loop body; `current` (the highlighted step in the UI) only tracks the top level.
  private async runSequence(workflow: Workflow, steps: Step[], signal: AbortSignal, scope: { top: boolean; prefix: string }) {
    const state = this.state!;
    const unreachable = new Set<string>(); // dry run: tabs whose page a skipped action would have changed
    for (const [index, step] of steps.entries()) {
      if (scope.top) {
        state.current = index;
        this.changed();
      }
      const prefix = `${scope.prefix}Step ${index + 1}/${steps.length}`;
      if (!step.enabled) {
        this.record(state, step, 'skipped', 'Disabled.', null, scope.prefix);
        continue;
      }
      await this.checkpoint(step, index, steps.length, signal, scope.prefix);
      if (state.mode === 'dry' && step.type !== 'navigate' && unreachable.has(step.target.tab)) {
        this.record(state, step, 'skipped', 'Not checked in a dry run: an earlier step would have changed this page.', null, scope.prefix);
        continue;
      }
      for (;;) {
        if (step.type !== 'loop_pages' && step.type !== 'loop_items') this.currentStepId = step.id;
        const outcome = step.type === 'loop_pages' ? await this.loopPages(workflow, step, signal)
          : step.type === 'loop_items' ? await this.loopItems(workflow, step, signal, scope.prefix)
            : await this.runStep(workflow, step, signal);
        if (outcome.ok) {
          this.record(state, step, 'done', outcome.message, outcome.locator, scope.prefix);
          this.log.write('info', `${prefix} ${state.mode === 'dry' ? 'checked' : 'done'}: ${step.label}${outcome.locator ? ` (matched ${outcome.locator})` : ''}.`);
          if (state.mode === 'dry') {
            if (step.type === 'navigate') unreachable.delete(step.target.tab);
            else if (step.waitFor?.navigation || step.waitFor?.download || step.type === 'download') unreachable.add(step.target.tab);
            const opened = step.type === 'click' || step.type === 'download' ? step.params.opensTab : undefined;
            if (opened) unreachable.add(opened);
          }
          break;
        }
        if (step.onFail === 'pause') {
          // Human-in-the-loop: let the user fix the page (log in, wait out a countdown, close a dialog), then retry.
          this.log.write('warn', `${prefix} needs you: ${step.label}. ${outcome.message}`);
          await this.pauseHere(`${prefix} needs you: ${outcome.message} Fix it in the page, then press Resume to retry this step.`, signal);
          continue;
        }
        if (step.onFail === 'skip') {
          this.record(state, step, 'skipped', outcome.message, null, scope.prefix);
          this.log.write('warn', `${prefix} skipped: ${step.label}. ${outcome.message}`);
          break;
        }
        const screenshot = await this.capture(step);
        this.record(state, step, 'failed', outcome.message, null, scope.prefix, screenshot);
        this.lastFailed = step;
        this.noteFailure(step);
        throw new StepFailure(`${prefix} failed: ${step.label}. ${outcome.message}`, false);
      }
    }
  }

  // Read through a method: set inside runSequence, so a field read right after the call would be narrowed to null.
  private failedStep(): Step | null {
    return this.lastFailed;
  }

  private record(state: RunState, step: Step, status: StepRunResult['status'], message: string, locator: string | null, prefix = '', screenshot: string | null = null) {
    state.results.push({ stepId: step.id, label: `${prefix}${step.label}`, status, message, locator, ...(screenshot ? { screenshot } : {}) });
  }

  // The first failing step and its page: "Re-teach this step" reopens that page and records the step again.
  private noteFailure(step: Step) {
    const state = this.state!;
    if (state.failure || step.type === 'loop_pages' || step.type === 'loop_items') return;
    const contents = this.aliases.get(step.target.tab);
    const url = contents && !contents.isDestroyed() ? contents.getURL() : '';
    if (/^https?:/.test(url)) state.failure = { stepId: step.id, label: step.label, url };
  }

  // A picture of the page where a step failed (plan §6), best effort: a hidden window may yield an empty image.
  private async capture(step: Step): Promise<string | null> {
    const contents = this.aliases.get(step.target.tab);
    if (!this.saveScreenshot || !contents || contents.isDestroyed() || step.type === 'loop_pages' || step.type === 'loop_items') return null;
    try {
      const image = await contents.capturePage();
      return image.isEmpty() ? null : await this.saveScreenshot(image.toPNG());
    } catch {
      return null;
    }
  }

  // Plan §7, before a step acts: a site outside the allowlist, or a click that reads like buying, paying or deleting,
  // waits for your OK (Resume allows it for the rest of this run; Stop ends the run).
  private async safetyCheck(step: Step, signal: AbortSignal) {
    const { allowlist, confirmRisky } = this.safety();
    const contents = this.aliases.get(step.target.tab);
    const url = step.type === 'navigate' ? step.params.url : contents && !contents.isDestroyed() ? contents.getURL() : '';
    let host = '';
    try {
      host = /^https?:/.test(url) ? new URL(url).host.toLowerCase() : '';
    } catch { /* not a web address */ }
    const listed = (candidate: string) => allowlist.some(entry => entry === candidate || (entry.startsWith('*.') && (candidate === entry.slice(2) || candidate.endsWith(entry.slice(1)))));
    if (host && allowlist.length && !listed(host) && !listed(host.replace(/:\d+$/, '')) && !this.allowedHosts.has(host)) {
      await this.askPerson('site', `This run wants to use ${host}, which is not on your list of allowed sites. Press Resume to allow it for this run, or Stop.`, signal);
      this.allowedHosts.add(host);
    }
    const acts = step.type === 'click' || step.type === 'download';
    if (confirmRisky && acts && !this.allowedSteps.has(step.id) && RISKY.test(step.label) && !/^Download\b/.test(step.label)) {
      await this.askPerson('confirm', `"${step.label}" looks like buying, paying or deleting something. Press Resume to allow it for this run, or Stop.`, signal);
      this.allowedSteps.add(step.id);
    }
  }

  // A pause that only you can end (Resume or Stop), shown as "Needs you" with its reason.
  private async askPerson(kind: 'confirm' | 'site', message: string, signal: AbortSignal) {
    const state = this.state!;
    state.waitingFor = kind;
    this.log.write('warn', `Needs you: ${message}`);
    const contents = this.aliases.get('main');
    if (contents && !contents.isDestroyed()) this.onAttention?.(contents, message);
    try {
      await this.pauseHere(`Needs you: ${message}`, signal);
    } finally {
      state.waitingFor = null;
    }
  }

  // ---------- page loops ----------

  // Asks the list tab's top frame a read-only question, retrying while the page is still loading.
  private async ask<Q extends RecorderQuery>(contents: WebContents, query: Q, signal: AbortSignal, limitMs = EFFECT_TIMEOUT_MS): Promise<QueryResults[Q['kind']]> {
    const end = Date.now() + limitMs;
    let last = 'The page did not answer.';
    while (Date.now() < end) {
      if (signal.aborted) throw new Stopped();
      const answer = await this.bridge.query(contents, [], query, Math.min(ATTEMPT_TIMEOUT_MS + 5000, Math.max(500, end - Date.now())));
      if (answer.ok) return answer.value;
      last = answer.message;
      await sleep(250, signal);
    }
    throw new StepFailure(last, true);
  }

  // Runs the body on every page and moves on with the learned pagination until a stop condition holds:
  // the next control is missing or disabled, a page repeats earlier content, a page brings no new links,
  // "load more"/scrolling loads nothing, or maxPages is reached.
  private async loopPages(workflow: Workflow, step: Extract<Step, { type: 'loop_pages' }>, signal: AbortSignal): Promise<Outcome | Failure> {
    const state = this.state!;
    const { pagination, maxPages, steps } = step.params;
    let contents: WebContents;
    try {
      contents = this.tab(step.target.tab);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The list tab is not open.' };
    }
    const seenLinks = new Set<string>();
    const seenPages = new Set<string>();
    let page = 1;
    let stop = '';
    try {
      for (;;) {
        await this.network.idle(contents.id, IDLE_QUIET_MS, IDLE_LIMIT_MS, signal);
        const signature = await this.ask(contents, { kind: 'signature' }, signal);
        if (seenPages.has(signature.hash)) {
          stop = `page ${page} repeats an earlier page`;
          break;
        }
        seenPages.add(signature.hash);
        const fresh = signature.links.filter(link => !seenLinks.has(link));
        for (const link of fresh) seenLinks.add(link);
        if (page > 1 && fresh.length === 0) {
          stop = `page ${page} brought no new links`;
          break;
        }
        this.pageLabel = `Page ${page}`;
        state.progress = `Page ${page}: ${fresh.length} new links (${seenLinks.size} in total)`;
        this.log.write('info', `${step.label} · ${state.progress}.`);
        this.changed();
        await this.runSequence(workflow, steps, signal, { top: false, prefix: `Page ${page} › ` });
        if (state.mode === 'dry') {
          // The description is a full sentence; the stop reason gets its own closing period below.
          stop = `dry run: would continue with ${pagination.description.replace(/\.$/, '')}`;
          break;
        }
        if (this.itemLimitHit) {
          stop = 'the item limit was reached';
          break;
        }
        if (page >= maxPages) {
          stop = `reached the limit of ${maxPages} pages`;
          break;
        }
        const advanced = await this.advance(contents, step, page, signature.hash, signal);
        if (advanced !== true) {
          stop = advanced;
          break;
        }
        page++;
      }
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return { ok: false, message: `Page ${page}: ${error instanceof Error ? error.message : 'unknown error'}` };
    } finally {
      state.progress = null;
      this.pageLabel = null;
    }
    return { ok: true, locator: null, message: `Visited ${page} page${page === 1 ? '' : 's'} (${seenLinks.size} content links). Stopped because ${stop}.` };
  }

  // ---------- item loops ----------

  // Lists the items of the list tab's current page, waiting a little for lists that render after load.
  private async findItems(list: WebContents, step: Extract<Step, { type: 'loop_items' }>, signal: AbortSignal) {
    const { pattern, exclude } = step.params;
    const end = Date.now() + Math.min(step.timeoutMs, 10_000);
    for (;;) {
      // highlight: the user sees which items the run is working through.
      const found = await this.ask(list, { kind: 'find-items', pattern, highlight: true, exclude }, signal);
      if (found.items.length > 0 || Date.now() >= end) return found;
      await sleep(500, signal);
    }
  }

  private async loopItems(workflow: Workflow, step: Extract<Step, { type: 'loop_items' }>, signal: AbortSignal, prefix: string): Promise<Outcome | Failure> {
    const state = this.state!;
    const { pattern, maxItems, exclude, steps } = step.params;
    let list: WebContents;
    let found: QueryResults['find-items'];
    try {
      list = this.tab(step.target.tab);
      await this.network.idle(list.id, IDLE_QUIET_MS, IDLE_LIMIT_MS, signal);
      found = await this.findItems(list, step, signal);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return { ok: false, message: `The list could not be read: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
    if (found.items.length === 0) return { ok: false, message: `No items found on this page. ${pattern.description}` };
    const seen = this.seenItems.get(step.id) ?? new Set<string>();
    this.seenItems.set(step.id, seen);
    const excluded = new Set(exclude);
    const unseen = found.items.filter(item => !excluded.has(item.url) && !seen.has(item.url));
    // Items whose file a previous run already downloaded are not even opened (unless Force is on).
    const downloaded = this.downloads ? unseen.filter(item => this.downloads!.isItemDone(item.url)) : [];
    const fresh = unseen.filter(item => !downloaded.includes(item));
    const skipped = found.items.filter(item => excluded.has(item.url)).length;
    const repeated = found.items.length - unseen.length - skipped;
    const extras = [
      skipped ? `${skipped} excluded by you` : '',
      repeated ? `${repeated} already done earlier in this run` : '',
      downloaded.length ? `${downloaded.length} already downloaded` : '',
      found.loose ? 'found by a looser match because the item links moved; check the highlighted items' : '',
    ].filter(Boolean);
    const also = extras.length ? ` (${extras.join('; ')})` : '';
    if (state.mode === 'dry') {
      const first = fresh[0] ? ` First: "${fresh[0].title}".` : '';
      return { ok: true, locator: null, message: `Found ${found.items.length} items, ${fresh.length} to open${also}; highlighted, not opened (dry run).${first}` };
    }

    let done = 0;
    let limited = false;
    const failed: string[] = [];
    const itemTab = this.tabs.create('about:blank').webContents;
    this.aliases.set('item', itemTab);
    try {
      for (const [index, item] of fresh.entries()) {
        if (seen.size >= maxItems) {
          limited = true;
          this.itemLimitHit = true;
          break;
        }
        seen.add(item.url);
        const where = `${prefix}Item ${index + 1}/${fresh.length} › `;
        state.progress = `${this.pageLabel ? `${this.pageLabel} · ` : ''}Item ${index + 1} of ${fresh.length}: ${item.title}`;
        this.log.write('info', `${step.label} · ${state.progress}.`);
        this.changed();
        const tabsBefore = new Set(this.aliases.keys());
        const record = { url: item.url, title: item.title, sourcePage: list.isDestroyed() ? '' : list.getURL() };
        this.currentItem = { ...record, loopStepId: step.id };
        this.lastFailed = null;
        this.downloads?.markItem(record, 'pending');
        try {
          await this.openItem(itemTab, item.url, signal);
          await this.captureDetails(itemTab, record, signal);
          await this.runSequence(workflow, steps, signal, { top: false, prefix: where });
          done++;
        } catch (error) {
          if (error instanceof Stopped) throw error;
          // The page opened but its download step failed (link missing, dead, an error page): "no download".
          this.downloads?.markItem(record, this.failedStep()?.type === 'download' ? 'no_download' : 'failed');
          const message = error instanceof Error ? error.message : 'Unknown error.';
          failed.push(`"${item.title}": ${message}`);
          this.record(state, step, 'failed', message, null, `${where}${item.title} · `);
          this.log.write('warn', `Item "${item.title}" failed: ${message} Continuing with the next item.`);
        } finally {
          this.currentItem = null;
          this.closeTabsSince(tabsBefore);
        }
      }
    } finally {
      this.aliases.delete('item');
      // Select the list first: closing the active tab would otherwise make some other tab active.
      if (!list.isDestroyed()) {
        try {
          this.tabs.select(list.id); // pagination clicks are real input: the list must be the visible tab again
        } catch { /* the list tab is gone; the next step reports it */ }
      }
      this.closeTab(itemTab);
    }
    const limit = limited ? `; stopped at the limit of ${maxItems} item${maxItems === 1 ? '' : 's'}` : '';
    if (done === 0 && failed.length > 0) {
      return { ok: false, message: `All ${failed.length} item${failed.length === 1 ? '' : 's'} failed${also}. First: ${failed[0]}` };
    }
    const failures = failed.length ? `; ${failed.length} failed (${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '; …' : ''})` : '';
    return { ok: true, locator: null, message: `Opened ${done} item${done === 1 ? '' : 's'}${failures}${limit}${also}.` };
  }

  // Reads the item page's details (title, tags, date, password …) and stores them with the item, before its download
  // starts: the download may happen on another page (a file host) where these details are not shown. Best effort.
  private async captureDetails(contents: WebContents, item: { url: string; title: string; sourcePage: string }, signal: AbortSignal) {
    const labels = this.downloads?.metadataLabels() ?? [];
    if (!this.downloads || labels.length === 0) return;
    try {
      const page = await this.ask(contents, { kind: 'extract-metadata', labels }, signal, 5000);
      const metadata = toItemMetadata(page);
      this.downloads.markItem({ ...item, metadata }, 'pending');
      // Labels only: values can be passwords, which never go into the log.
      if (Object.keys(metadata).length > 1) this.log.write('info', `Item details: ${detailLabels(metadata).join(', ')}.`);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      this.log.write('warn', `Could not read the details of "${item.title}"; its download is kept without them.`);
    }
  }

  private async openItem(contents: WebContents, url: string, signal: AbortSignal) {
    if (!isBrowserUrl(url)) throw new StepFailure('The item link is not an http(s) address.', false);
    await this.pace('item', url, signal);
    try {
      await untilStopped(contents.loadURL(url), signal);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      throw new StepFailure(`The item page could not be opened: ${error instanceof Error ? error.message : 'load failed'}.`, false);
    }
    await this.network.idle(contents.id, IDLE_QUIET_MS, IDLE_LIMIT_MS, signal);
  }

  // Tabs (popups) that an item opened are closed before the next item, so 50 items do not leave 50 tabs behind.
  private closeTabsSince(before: Set<string>) {
    for (const [alias, contents] of [...this.aliases]) {
      if (before.has(alias)) continue;
      this.aliases.delete(alias);
      this.closeTab(contents);
    }
  }

  private closeTab(contents: WebContents) {
    if (contents.isDestroyed()) return;
    try {
      this.tabs.close(contents.id);
    } catch { /* already closed by the page */ }
  }

  // Moves the list to its next page. Returns true, or the reason the list has ended.
  private async advance(contents: WebContents, step: Extract<Step, { type: 'loop_pages' }>, page: number, hash: string, signal: AbortSignal): Promise<true | string> {
    const { pagination } = step.params;
    await this.pace(step.target.tab, null, signal);
    switch (pagination.kind) {
      case 'url': {
        const url = pagination.template.replaceAll('{{page}}', String(page + 1));
        try {
          await contents.loadURL(url);
        } catch (error) {
          return `page ${page + 1} could not be opened (${error instanceof Error ? error.message : 'load failed'})`;
        }
        return true;
      }
      case 'infinite-scroll': {
        const probe = await this.ask(contents, { kind: 'scroll-probe', waitMs: 5000 }, signal);
        return probe.after > probe.before ? true : 'scrolling to the bottom loaded nothing new';
      }
      case 'next':
      case 'load-more': {
        const control = await this.ask(contents, { kind: 'control-state', locators: pagination.locators, shadowHosts: pagination.shadowHosts }, signal);
        const name = pagination.kind === 'next' ? 'the next control' : 'the "load more" control';
        if (control.state !== 'enabled') return `${name} is ${control.state}`;
        // Same path as any recorded click: settle, obstruction and banner handling, trusted input.
        const click = { ...step, type: 'click', params: {}, locators: pagination.locators, target: { ...step.target, shadowHosts: pagination.shadowHosts } } as Step;
        await this.act(contents, click, ATTEMPT_TIMEOUT_MS + 2000);
        // The click either navigates (classic pagination) or changes content in place (SPA, load more); a changed
        // content signature covers both. While a new document loads, the query simply goes unanswered.
        const end = Date.now() + EFFECT_TIMEOUT_MS;
        while (Date.now() < end) {
          await sleep(300, signal);
          const answer = await this.bridge.query(contents, [], { kind: 'signature' }, ATTEMPT_TIMEOUT_MS);
          if (answer.ok && answer.value.hash !== hash) return true;
        }
        return `pressing ${name} changed nothing within ${EFFECT_TIMEOUT_MS / 1000} s`;
      }
    }
  }

  // Polls retryable failures until the step's timeout; repeats a failed *action* only when onFail is 'retry'.
  private async runStep(workflow: Workflow, step: Step, signal: AbortSignal): Promise<Outcome | Failure> {
    if (!(RECORDABLE_STEP_TYPES as readonly string[]).includes(step.type)) {
      return { ok: false, message: `"${step.type}" steps are not supported until a later milestone.` };
    }
    await this.pace(step.target.tab, step.type === 'navigate' ? step.params.url : null, signal);
    if (this.state!.mode !== 'dry') await this.safetyCheck(step, signal);
    let deadline = Date.now() + step.timeoutMs;
    let started = Date.now();
    let polls = 0;
    let retries = 0;
    let checkedAt = 0;
    for (;;) {
      if (signal.aborted) throw new Stopped();
      try {
        return await this.attempt(workflow, step, deadline, signal);
      } catch (error) {
        if (error instanceof Stopped) throw error;
        const failure = error instanceof StepFailure ? error : new StepFailure(error instanceof Error ? error.message : 'Unknown error.', false);
        // Something only a person can get past (captcha, login, countdown): wait for them, then start the step afresh.
        if (failure.retryable && this.state!.mode !== 'dry' && Date.now() - checkedAt >= 900) {
          checkedAt = Date.now();
          const wait = await this.needsPerson(step, failure, Date.now() - started);
          if (wait) {
            await this.waitForPerson(step, wait, signal);
            deadline = Date.now() + step.timeoutMs;
            started = Date.now();
            polls = 0;
            continue;
          }
        }
        const timeLeft = Date.now() < deadline;
        if (failure.retryable && timeLeft) {
          await sleep(Math.min(1000, 150 * 2 ** polls++), signal);
          continue;
        }
        if (!failure.retryable && !failure.final && step.onFail === 'retry' && retries < ACTION_RETRIES && timeLeft) {
          retries++;
          this.log.write('warn', `Retrying "${step.label}" (${retries}/${ACTION_RETRIES}): ${failure.message}`);
          await sleep(500 * retries, signal);
          continue;
        }
        const waited = failure.retryable ? ` Waited ${Math.round(step.timeoutMs / 1000)} s.` : '';
        return { ok: false, message: `${failure.message}${waited}` };
      }
    }
  }

  // Politeness: a random pause between steps plus a minimum interval between steps on the same host.
  // `url`: where the step is going (navigations); otherwise the tab's current page decides the host.
  private async pace(tab: string, url: string | null, signal: AbortSignal) {
    if (this.state!.mode === 'dry') return;
    const { stepDelayMinMs, stepDelayMaxMs, hostIntervalMs } = this.settings();
    const contents = this.aliases.get(tab);
    const host = url ? hostOf(url) : contents && !contents.isDestroyed() ? hostOf(contents.getURL()) : '';
    let wait = 0;
    if (this.state!.results.length > 0) wait = stepDelayMinMs + Math.random() * (stepDelayMaxMs - stepDelayMinMs);
    const last = host ? this.lastStepAt.get(host) : undefined;
    if (last !== undefined) wait = Math.max(wait, last + hostIntervalMs - Date.now());
    if (wait > 0) await sleep(wait, signal);
    if (host) this.lastStepAt.set(host, Date.now());
  }

  private tab(alias: string): WebContents {
    const contents = this.aliases.get(alias);
    if (!contents || contents.isDestroyed()) throw new StepFailure(`Tab ${alias} is not open.`, alias !== 'main');
    return contents;
  }

  private base(step: Step) {
    return { locators: step.locators, shadowHosts: step.target.shadowHosts, highlight: true };
  }

  private async attempt(workflow: Workflow, step: Step, deadline: number, signal: AbortSignal): Promise<Outcome> {
    const dry = this.state!.mode === 'dry';
    if (step.type === 'navigate') {
      if (!isBrowserUrl(step.params.url)) throw new StepFailure('The URL is not an http(s) address.', false);
      const contents = this.tab(step.target.tab);
      try {
        await contents.loadURL(step.params.url);
      } catch (error) {
        throw new StepFailure(`Could not open ${step.params.url}: ${error instanceof Error ? error.message : 'load failed'}.`, true);
      }
      await this.network.idle(contents.id, IDLE_QUIET_MS, IDLE_LIMIT_MS, signal);
      return { ok: true, locator: null, message: 'Done.' };
    }
    if (step.type === 'wait') {
      if (!dry) await sleep(step.params.ms, signal);
      return { ok: true, locator: null, message: dry ? 'Not waited in a dry run.' : 'Done.' };
    }
    const contents = this.tab(step.target.tab);
    // Best effort: a page that keeps polling forever must not block the step; the element checks still apply.
    await this.network.idle(contents.id, IDLE_QUIET_MS, Math.min(IDLE_LIMIT_MS, Math.max(0, deadline - Date.now())), signal);
    const timeout = Math.max(500, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));

    if (dry) {
      // A window scroll has no element to find; there is nothing to check without acting.
      if (step.locators.length === 0) return { ok: true, locator: null, message: 'Nothing to find (window scroll); not acted on (dry run).' };
      const result = await this.bridge.send(contents, step.target.frames, { ...this.base(step), action: { kind: 'none' }, heal: true }, timeout);
      const done = this.accept(result);
      const note = done.healed ? ` ${done.healed} (not saved: dry run)` : done.refreshed ? ' A fallback locator was needed (not saved: dry run).' : '';
      return { ok: true, locator: `${done.strategy}: ${done.value}`, message: `Found and highlighted; not acted on (dry run).${note}` };
    }

    const opensTab = (step.type === 'click' || step.type === 'download') ? step.params.opensTab : undefined;
    const expectsDownload = step.type === 'download' || step.waitFor?.download === true;
    // Listen before acting: the effect can arrive before the command's reply does.
    const navigation = step.waitFor?.navigation
      ? this.waitFor(s => (s.kind === 'navigate' && s.contents === contents ? s : undefined), EFFECT_TIMEOUT_MS,
        `The action ran, but the page did not change within ${EFFECT_TIMEOUT_MS / 1000} s.`)
      : null;
    const popup = opensTab
      ? this.waitFor(s => (s.kind === 'popup' && s.opener === contents ? s.popup : undefined), EFFECT_TIMEOUT_MS,
        `The action ran, but no new tab opened within ${EFFECT_TIMEOUT_MS / 1000} s.`)
      : null;
    const downloadLimit = Math.max(EFFECT_TIMEOUT_MS, step.timeoutMs);
    // Downloads may come from any tab of this run, including a popup that is about to open.
    const download = expectsDownload
      ? this.waitFor(s => (s.kind === 'download' && [...this.aliases.values()].includes(s.contents) ? s.download : undefined),
        downloadLimit, `The action ran, but no download started within ${Math.round(downloadLimit / 1000)} s.`)
      : null;
    // A download link that leads to an error page (dead link, expired page) shows as a navigation with an HTTP error
    // status: fail at once instead of waiting out the download timeout.
    const deadEnd = expectsDownload
      ? this.waitFor(s => (s.kind === 'navigate' && !s.inPage && s.status >= 400 && [...this.aliases.values()].includes(s.contents) ? s : undefined),
        downloadLimit + 1000, '')
      : null;
    const waiters = [navigation, popup, download, deadEnd].filter(waiter => waiter !== null);
    try {
      const done = await this.act(contents, step, timeout);
      if (signal.aborted) throw new Stopped();
      // From here on the action has happened: failures are not retryable, or the action would repeat.
      if (done.banner) this.log.write('info', `Dismissed a cookie banner ("${done.banner}") before "${step.label}".`);
      if (done.refreshed) this.heal(workflow, step, done.refreshed, done.healed ?? `The best recorded locator no longer matched; matched by ${done.strategy} instead.`);
      if (popup && opensTab) this.aliases.set(opensTab, await untilStopped(popup.promise, signal));
      if (navigation) {
        const navigated = await untilStopped(navigation.promise, signal);
        // A new document needs its recorder before the next step can talk to it; in-page routes keep the old one.
        if (!navigated.inPage) await this.documentReady(contents, signal);
      }
      if (download) {
        const outcome = deadEnd
          ? await untilStopped(Promise.race([download.promise, deadEnd.promise.then(page => ({ deadEnd: page.status }))]), signal)
          : await untilStopped(download.promise, signal);
        if ('deadEnd' in outcome) throw new StepFailure(`The download link led to an error page (HTTP ${outcome.deadEnd}) instead of a file.`, false, true);
        this.log.write('info', `Download started: ${outcome.filename ?? 'unnamed file'} (handed to the download queue).`);
      }
      return { ok: true, locator: `${done.strategy}: ${done.value}`, message: done.healed ? `Healed. ${done.healed}` : 'Done.' };
    } finally {
      for (const waiter of waiters) waiter.cancel();
    }
  }

  // Performs the step's action. Clicks in the top frame are real OS-level input (isTrusted, user activation);
  // inside iframes the recorder dispatches synthetic input, because frame offsets are not reliably known here.
  private async act(contents: WebContents, step: Step, timeout: number) {
    const command = this.commandFor(step);
    const click = command.action.kind === 'click' && step.target.frames.length === 0;
    // A minimized window leaves new tabs (each page's item tab) with a 0×0 viewport, where OS-level input hits nothing.
    // Fall back to the in-page click, as inside iframes, rather than wait out a timeout for every item.
    const hidden = click && this.tabs.hidden();
    if (hidden && !this.hiddenNoted) {
      this.hiddenNoted = true;
      this.log.write('info', 'The Vestigium window is minimized, so clicks are performed inside the page instead of with real mouse input. If a site ignores them, restore the window.');
    }
    const trusted = click && !hidden;
    if (!trusted) return this.accept(await this.bridge.send(contents, step.target.frames, command, timeout));
    const located = this.accept(await this.bridge.send(contents, [], { ...command, action: { kind: 'locate' } }, timeout));
    if (!located.point) throw new StepFailure('The page did not report where to click.', true);
    const zoom = contents.getZoomFactor();
    const x = Math.round(located.point.x * zoom);
    const y = Math.round(located.point.y * zoom);
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return located;
  }

  private accept(result: Awaited<ReturnType<FrameCommandBridge['send']>>): RecorderResult & { status: 'done' } {
    if (result.status === 'done') return result;
    throw new StepFailure(result.message, result.status !== 'error', false, result.status === 'not-found' || result.status === 'not-ready' ? result.status : null);
  }

  // The workflow learns: fresh locators replace the stale ones, and the step is flagged for the user's review.
  private heal(workflow: Workflow, step: Step, locators: Locator[], reason: string) {
    step.locators = locators;
    this.log.write('warn', `Self-healed "${step.label}": ${reason} The step is flagged for review.`);
    try {
      this.onHeal(workflow.id, step.id, locators, reason);
    } catch (error) {
      this.log.write('error', `Could not save the healed locators: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // Best effort: proceeds after the timeout anyway, because the next step polls for its element regardless.
  private async documentReady(contents: WebContents, signal: AbortSignal) {
    if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
    let finish = () => {};
    const ready = new Promise<void>(resolve => {
      const timer = setTimeout(() => finish(), EFFECT_TIMEOUT_MS);
      const onReady = () => finish();
      finish = () => {
        clearTimeout(timer);
        if (!contents.isDestroyed()) contents.removeListener('dom-ready', onReady);
        resolve();
      };
      contents.once('dom-ready', onReady);
    });
    await untilStopped(ready, signal).finally(() => finish());
  }

  private commandFor(step: Step): RecorderCommand {
    const base = { ...this.base(step), heal: true };
    switch (step.type) {
      case 'click':
      case 'download':
        return { ...base, action: { kind: 'click' } };
      case 'type':
        return { ...base, action: { kind: 'type', value: step.params.value, ...(step.params.key ? { key: step.params.key } : {}) } };
      case 'select':
        return { ...base, action: { kind: 'select', value: step.params.value, label: step.params.label } };
      case 'scroll':
        return { ...base, action: { kind: 'scroll', x: step.params.x, y: step.params.y } };
      default:
        throw new StepFailure(`"${step.type}" steps are not supported until a later milestone.`, false);
    }
  }
}
