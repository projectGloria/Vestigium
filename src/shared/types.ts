import type { FoundItem, ItemPattern, PaginationPattern } from './learn.js';
export interface Versioned { schemaVersion: 1 }
export interface Locator { strategy: 'role' | 'text' | 'testid' | 'css' | 'xpath' | 'fingerprint'; value: string; confidence: number }
// 'scroll' extends the plan's node list: the plan requires recording scroll but names no node for it.
export const STEP_TYPES = [
  'navigate', 'click', 'type', 'select', 'scroll', 'wait', 'extract', 'download',
  'loop_pages', 'loop_items', 'condition', 'run_workflow',
] as const;
export type StepType = (typeof STEP_TYPES)[number];
// Step types the milestone 2 runner executes; the rest are reserved for later milestones and rejected at run time.
export const RECORDABLE_STEP_TYPES = ['navigate', 'click', 'type', 'select', 'scroll', 'wait', 'download'] as const;

// One hop in the frame tree, from the top document down. `index` is the position among same-parent frames.
export interface FrameRef { url: string; name: string; index: number }
// Where a step acts. `tab` is an alias ('main', 'item', 'popup-1', ...) because tab IDs do not survive replays.
// 'item' is the tab an item loop opens each item in.
// `shadowHosts` holds one CSS selector per shadow root crossed, outermost first; selectors cannot pierce shadow roots.
export interface StepTarget { tab: string; frames: FrameRef[]; shadowHosts: string[] }
export interface StepWait { navigation?: boolean; download?: boolean }

export interface StepParamsMap {
  navigate: { url: string };
  click: { opensTab?: string };
  // `value` is the final field value; `null` keeps the field as it is (a bare Enter/Tab press). `key` is pressed after.
  type: { value: string | null; key?: 'Enter' | 'Tab' };
  select: { value: string; label: string };
  // Target-less scroll means the window.
  scroll: { x: number; y: number };
  wait: { ms: number };
  download: { filename: string | null; mimeType: string | null; opensTab?: string };
  extract: Record<string, unknown>;
  // Runs `steps` on every page of a list, moving on with `pagination`, at most `maxPages` pages.
  loop_pages: { pagination: PaginationPattern; maxPages: number; steps: Step[] };
  // Opens every item of the list (in the "item" tab) and runs `steps` there. `listUrl` is where it was taught;
  // `exclude` holds item URLs the user unticked; `maxItems` caps the whole run (across pages).
  loop_items: { pattern: ItemPattern; listUrl: string; maxItems: number; exclude: string[]; steps: Step[] };
  condition: Record<string, unknown>;
  run_workflow: Record<string, unknown>;
}

// Set when a run had to heal a step (its best locator no longer matched). `previous` allows undoing the heal.
export interface StepReview { reason: string; at: string; previous: Locator[] }

interface StepBase<T extends StepType> {
  id: string; type: T; label: string; enabled: boolean; locators: Locator[]; params: StepParamsMap[T];
  target: StepTarget; waitFor: StepWait | null; timeoutMs: number; onFail: 'retry' | 'skip' | 'pause' | 'abort';
  review?: StepReview;
}
// Distributes over StepType so `step.type === 'type'` narrows `step.params`.
export type Step = { [T in StepType]: StepBase<T> }[StepType];
export interface Workflow extends Versioned { id: string; name: string; siteProfileId: string | null; steps: Step[]; variables: Record<string, unknown>; createdAt: string; version: number }
export interface SiteProfile extends Versioned {
  id: string; domain: string; listPattern: Record<string, unknown> | null; itemPattern: Record<string, unknown> | null;
  paginationPattern: Record<string, unknown> | null; downloadPattern: Record<string, unknown> | null;
  metadataPatterns: Record<string, string>; rateLimit: number; lastVerifiedAt: string | null; health: 'ok' | 'degraded' | 'broken';
}
// An item of a list (or the page a manual download came from). `url` is the item page; it is the dedupe key that
// lets a later run skip items whose download already finished.
export interface Item extends Versioned { id: string; url: string; title: string; sourcePage: string; metadata: Record<string, string>; status: 'pending' | 'done' | 'failed' | 'no_download' }
export type DownloadStatus = 'queued' | 'running' | 'paused' | 'verifying' | 'done' | 'failed' | 'cancelled';
// Which step of which workflow produced a download, so an expired link can be re-resolved by redoing that step.
// `loopStepId`: the item loop the step ran in (its body is redone on the item page), or null for a top-level step.
export interface DownloadOrigin { workflowId: string; stepId: string; loopStepId: string | null }
// One file transfer. The plan's fields, plus what resuming and dedupe need:
// - `tempPath` is the `.part` file; its size (not `receivedBytes`) is where a resume starts, because it survives a crash.
// - `etag`/`lastModified` go into If-Range, so a resume never splices two different versions of a file.
// - `sourcePage` is the page whose click started the download (sent as Referer, and reopened to renew an expired link).
// - `sha256` is set once verified; `duplicateOf` names an earlier job with identical bytes (this copy was not kept).
export interface DownloadJob extends Versioned {
  id: string; itemId: string | null; url: string; filename: string; tempPath: string; finalPath: string;
  totalBytes: number | null; receivedBytes: number; status: DownloadStatus; attempts: number; error: string | null;
  title: string; sourcePage: string | null; mimeType: string | null; etag: string | null; lastModified: string | null;
  sha256: string | null; duplicateOf: string | null; origin: DownloadOrigin | null; createdAt: string; finishedAt: string | null;
  // Milestone 7, after the file is placed (optional so milestone 6 documents stay valid): the sidecar written next
  // to it, the folder it was unpacked into, and what happened when unpacking ("Not unpacked: wrong password").
  sidecarPath?: string | null; extractedTo?: string | null; extractNote?: string | null;
  // Labels of the item page's details known for this download (never values), for the queue table.
  details?: string[];
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry extends Versioned { id: string; time: string; level: LogLevel; message: string }
export type Theme = 'light' | 'dark';
export interface WindowBounds { x?: number; y?: number; width: number; height: number }
// Politeness between replayed steps: a random pause in [stepDelayMinMs, stepDelayMaxMs] and a minimum interval
// between steps on the same host. Also the default for hosts without a site profile.
export interface RunSettings { stepDelayMinMs: number; stepDelayMaxMs: number; hostIntervalMs: number }
// `directory` '' means the default (Downloads\Vestigium). `force` downloads items again even when already done.
// `template` places files ("{site}/{tag}/{title}.{ext}", see downloads/filename.ts); `sidecar` writes <name>_info.txt;
// `extract` unpacks archives with the item's password: 'keep' keeps the archive, 'delete' removes it once unpacked.
export interface DownloadSettings {
  directory: string; concurrency: number; retries: number; force: boolean;
  template: string; sidecar: boolean; extract: 'off' | 'keep' | 'delete';
}
// The labels whose values are captured from item pages ("Password", "Author" …), matched case-insensitively.
export interface MetadataSettings { labels: string[] }
// Plan §7. `allowlist`: sites a run may open or act on (empty: any site). `confirmRisky`: pause before a click whose
// target reads like buying, paying, deleting or unsubscribing, until you allow it.
export interface SafetySettings { allowlist: string[]; confirmRisky: boolean }
// Plan §6: "minimize while running" hides the window to the tray icon while a run or downloads are active.
export interface TraySettings { minimizeToTray: boolean }
// Network-level ad and tracker blocking in browser tabs (filter lists; see main/browser/ad-blocker.ts).
export interface AdBlockSettings { enabled: boolean }
// `filters`: network filters loaded (0: no lists). `listsUpdated`: when the lists in use were fetched (ISO).
// `blocked`: requests and popups blocked since the app started.
export interface AdBlockStatus { enabled: boolean; filters: number; listsUpdated: string | null; blocked: number }
export interface Settings {
  theme: Theme; lastUrl: string; windowBounds: WindowBounds; run: RunSettings; downloads: DownloadSettings; metadata: MetadataSettings;
  safety: SafetySettings; tray: TraySettings; adblock: AdBlockSettings;
}
export interface BrowserTab { id: number; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error: string | null }
export interface WorkflowSummary { id: string; name: string; steps: number; createdAt: string }
export interface RecordingState { active: boolean; events: number }
export type RunStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped';
// run: everything; step: pause before each step; dry: find and highlight targets without acting.
export type RunMode = 'run' | 'step' | 'dry';
// `locator` names the locator that matched ("role: link \"Download ZIP\""), so drift is visible after a run.
// `screenshot`: for a failure, the file name of a picture of the page at that moment (opened through main).
export interface StepRunResult { stepId: string; label: string; status: 'done' | 'skipped' | 'failed'; message: string; locator: string | null; screenshot?: string | null }
export interface RunState {
  workflowId: string; workflowName: string; mode: RunMode; status: RunStatus; current: number | null; total: number;
  results: StepRunResult[]; error: string | null; startedAt: string; finishedAt: string | null;
  // Why the run is paused (step mode, a pause request), shown next to the Resume/Next controls.
  pauseReason: string | null;
  // Where a loop is ("Page 3: 10 new links (30 in total)"), while one runs.
  progress: string | null;
  // Set while the run waits for a person (plan §4): a captcha to solve, a login, or a countdown/confirmation.
  // The run continues by itself once the page is ready again; Resume and Stop still work.
  waitingFor: 'captcha' | 'login' | 'countdown' | 'confirm' | 'site' | null;
  // The first step that failed and the page it was on: what "Re-teach this step" opens.
  failure: { stepId: string; label: string; url: string } | null;
}
// A finished run, kept in the run_log table for the History tab.
export interface RunRecord extends Versioned {
  id: string; workflowId: string; workflowName: string; mode: RunMode; status: RunStatus; startedAt: string; finishedAt: string | null;
  error: string | null; done: number; failed: number; skipped: number; failure: RunState['failure'];
  // Failed steps and items with their messages and screenshots (at most 50).
  failures: StepRunResult[];
}
export interface SiteProfileSummary {
  id: string; domain: string; health: SiteProfile['health']; lastVerifiedAt: string | null; listUrl: string | null;
  workflowId: string | null; workflowName: string | null; brokenStepId: string | null; brokenStepLabel: string | null;
}
// Items found on the page for an item loop, shown so the user can confirm them or exclude some.
export interface ItemPreview { workflowId: string; stepId: string; pageUrl: string; items: FoundItem[]; loose: boolean }
// One row of the queue table. Speed and ETA are live estimates, not stored.
export interface DownloadRow {
  id: string; title: string; filename: string; url: string; status: DownloadStatus; receivedBytes: number; totalBytes: number | null;
  bytesPerSecond: number | null; etaSeconds: number | null; error: string | null; finalPath: string | null; duplicateOf: string | null; attempts: number;
  // Labels (never values: they may hold passwords) of the details captured from the item page, and the unpack outcome.
  details: string[]; extractedTo: string | null; extractNote: string | null;
}
export interface DownloadsState {
  // `held`: "Pause all" is on; new downloads wait in the queue until "Resume all".
  rows: DownloadRow[]; directory: string; held: boolean;
  counts: { queued: number; running: number; paused: number; done: number; failed: number; cancelled: number };
  // All jobs not cancelled: bytes so far and the known total (null while any active job's size is unknown).
  receivedBytes: number; totalBytes: number | null;
}
export interface AppState {
  tabs: BrowserTab[]; activeTabId: number; settings: Settings; logs: LogEntry[];
  recording: RecordingState; workflows: WorkflowSummary[]; selectedWorkflow: Workflow | null; run: RunState | null;
  itemPreview: ItemPreview | null; downloads: DownloadsState;
  profiles: SiteProfileSummary[]; history: RunRecord[];
  // An http(s) link found on the clipboard when the window got focus, offered once in the address bar.
  clipboardUrl: string | null;
  // Set while re-teaching one step: the next recording replaces that step's locators.
  reteach: { workflowId: string; stepId: string; label: string } | null;
  adblock: AdBlockStatus;
}
