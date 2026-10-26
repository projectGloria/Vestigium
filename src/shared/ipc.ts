import type { AdBlockSettings, AppState, DownloadSettings, RunMode, RunSettings, SafetySettings, Theme, TraySettings } from './types.js';

export const CHANNELS = {
  state: 'vestigium:state', navigate: 'vestigium:navigate', back: 'vestigium:back',
  forward: 'vestigium:forward', reload: 'vestigium:reload', newTab: 'vestigium:new-tab',
  selectTab: 'vestigium:select-tab', closeTab: 'vestigium:close-tab', theme: 'vestigium:theme',
  recordStart: 'vestigium:record-start', recordStop: 'vestigium:record-stop',
  workflowRun: 'vestigium:workflow-run', runStop: 'vestigium:run-stop', runPause: 'vestigium:run-pause',
  runResume: 'vestigium:run-resume', runNext: 'vestigium:run-next', runSettings: 'vestigium:run-settings',
  workflowSelect: 'vestigium:workflow-select', workflowUpdate: 'vestigium:workflow-update', workflowDelete: 'vestigium:workflow-delete',
  workflowExport: 'vestigium:workflow-export', workflowImport: 'vestigium:workflow-import', workflowLearnPages: 'vestigium:workflow-learn-pages',
  workflowPreviewItems: 'vestigium:workflow-preview-items',
  downloadControl: 'vestigium:download-control', downloadSettings: 'vestigium:download-settings',
  downloadFolderChoose: 'vestigium:download-folder-choose', downloadFolderOpen: 'vestigium:download-folder-open',
  downloadShow: 'vestigium:download-show', metadataLabels: 'vestigium:metadata-labels',
  profileStart: 'vestigium:profile-start', profileDelete: 'vestigium:profile-delete', workflowReteach: 'vestigium:workflow-reteach',
  screenshotOpen: 'vestigium:screenshot-open', clipboardDismiss: 'vestigium:clipboard-dismiss',
  safetySettings: 'vestigium:safety-settings', traySettings: 'vestigium:tray-settings', adblockSettings: 'vestigium:adblock-settings',
  changed: 'vestigium:changed',
} as const;
// One edit from the workflow panel. `version` in the payload guards against applying it to a stale copy.
export type WorkflowChange =
  | { kind: 'rename'; name: string }
  | { kind: 'relabel'; stepId: string; label: string }
  | { kind: 'toggle'; stepId: string; enabled: boolean }
  | { kind: 'move'; stepId: string; direction: 'up' | 'down' }
  | { kind: 'delete-step'; stepId: string }
  // A healed step: keep the healed locators (clear the flag) or undo the heal (restore the recorded ones).
  | { kind: 'accept-review'; stepId: string }
  | { kind: 'revert-review'; stepId: string }
  | { kind: 'set-max-pages'; stepId: string; maxPages: number }
  // Item loops: leave one item out (or take it back), and cap how many items a run opens.
  | { kind: 'exclude-item'; stepId: string; url: string; excluded: boolean }
  | { kind: 'set-max-items'; stepId: string; maxItems: number };
export interface Payloads {
  state: undefined; navigate: { url: string }; back: undefined; forward: undefined; reload: undefined;
  newTab: undefined; selectTab: { id: number }; closeTab: { id: number }; theme: { theme: Theme };
  recordStart: undefined; recordStop: undefined; workflowRun: { id: string; mode: RunMode }; runStop: undefined;
  runPause: undefined; runResume: undefined; runNext: undefined; runSettings: RunSettings;
  workflowSelect: { id: string }; workflowUpdate: { id: string; version: number; change: WorkflowChange }; workflowDelete: { id: string };
  workflowExport: { id: string }; workflowImport: undefined; workflowLearnPages: { id: string; version: number };
  workflowPreviewItems: { id: string; stepId: string; show: boolean };
  downloadControl: { action: DownloadAction; id: string | null }; downloadSettings: DownloadOptions;
  downloadFolderChoose: undefined; downloadFolderOpen: undefined; downloadShow: { id: string }; metadataLabels: { labels: string[] };
  profileStart: { url: string | null }; profileDelete: { id: string }; workflowReteach: { id: string; stepId: string };
  screenshotOpen: { name: string }; clipboardDismiss: undefined; safetySettings: SafetySettings; traySettings: TraySettings; adblockSettings: AdBlockSettings;
}
// Queue controls for one job (id) or all jobs (null).
export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry';
// The folder is never sent by the renderer; it is picked with the native dialog in main (downloadFolderChoose).
export type DownloadOptions = Omit<DownloadSettings, 'directory'>;
export type Command = keyof Payloads;
export type Result = { ok: true; state: AppState } | { ok: false; error: string };
export interface Bridge {
  getState(): Promise<Result>; navigate(url: string): Promise<Result>;
  back(): Promise<Result>; forward(): Promise<Result>; reload(): Promise<Result>; newTab(): Promise<Result>;
  selectTab(id: number): Promise<Result>; closeTab(id: number): Promise<Result>; setTheme(theme: Theme): Promise<Result>;
  // Recording runs in the active tab; stopping compiles, saves and selects the new workflow.
  recordStart(): Promise<Result>; recordStop(): Promise<Result>;
  // Runs a saved workflow in the active tab; progress arrives through onState. Stop ends it after the current wait.
  runWorkflow(id: string, mode?: RunMode): Promise<Result>; stopRun(): Promise<Result>;
  // Pause takes effect before the next step; Resume continues (and leaves step mode); Next runs one step.
  pauseRun(): Promise<Result>; resumeRun(): Promise<Result>; nextStep(): Promise<Result>;
  setRunSettings(settings: RunSettings): Promise<Result>;
  selectWorkflow(id: string): Promise<Result>; updateWorkflow(id: string, version: number, change: WorkflowChange): Promise<Result>;
  deleteWorkflow(id: string): Promise<Result>;
  // Export and import open native file dialogs in main; the renderer never sees or chooses paths itself.
  exportWorkflow(id: string): Promise<Result>; importWorkflow(): Promise<Result>;
  // Analyzes the list open in the current tab and makes the workflow repeat on every page of it.
  learnPages(id: string, version: number): Promise<Result>;
  // Finds an item loop's items on the list (opening it if needed) and highlights them; show=false removes that.
  previewItems(id: string, stepId: string, show: boolean): Promise<Result>;
  // Download queue: pause/resume/cancel/retry one job or all (null); options; the folder via a native dialog;
  // open the folder, or show one finished file in Explorer.
  controlDownloads(action: DownloadAction, id: string | null): Promise<Result>; setDownloadOptions(options: DownloadOptions): Promise<Result>;
  chooseDownloadFolder(): Promise<Result>; openDownloadFolder(): Promise<Result>; showDownload(id: string): Promise<Result>;
  // The labels whose values are captured from item pages ("Password", "Author" …).
  setMetadataLabels(labels: string[]): Promise<Result>;
  // Site profiles (plan §2): run the learned workflow on `url` (null: the active tab's page), or forget a profile.
  startProfile(url: string | null): Promise<Result>; deleteProfile(id: string): Promise<Result>;
  // Records the right element for one broken step: opens the page where it failed and starts a short recording;
  // Stop recording then replaces only that step's locators.
  reteachStep(id: string, stepId: string): Promise<Result>;
  // Opens a failure screenshot (by the file name in the run history) in the system's image viewer.
  openScreenshot(name: string): Promise<Result>;
  dismissClipboard(): Promise<Result>;
  setSafety(settings: SafetySettings): Promise<Result>; setTray(settings: TraySettings): Promise<Result>;
  setAdBlock(settings: AdBlockSettings): Promise<Result>;
  onState(listener: (state: AppState) => void): () => void;
}
// Shared geometry keeps the native browser view within the visible React layout.
export const LAYOUT = { toolbar: 72, sidebar: 340, tabs: 42, bottom: 208 } as const;
