import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type Bridge, type Command, type Payloads, type Result } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';
const invoke = <K extends Command>(command: K, payload: Payloads[K]): Promise<Result> => ipcRenderer.invoke(CHANNELS[command], payload);
const bridge: Bridge = {
  getState: () => invoke('state', undefined), navigate: url => invoke('navigate', { url }),
  back: () => invoke('back', undefined), forward: () => invoke('forward', undefined), reload: () => invoke('reload', undefined),
  newTab: () => invoke('newTab', undefined), selectTab: id => invoke('selectTab', { id }), closeTab: id => invoke('closeTab', { id }),
  setTheme: theme => invoke('theme', { theme }),
  recordStart: () => invoke('recordStart', undefined), recordStop: () => invoke('recordStop', undefined),
  runWorkflow: (id, mode = 'run') => invoke('workflowRun', { id, mode }), stopRun: () => invoke('runStop', undefined),
  pauseRun: () => invoke('runPause', undefined), resumeRun: () => invoke('runResume', undefined), nextStep: () => invoke('runNext', undefined),
  setRunSettings: settings => invoke('runSettings', settings),
  selectWorkflow: id => invoke('workflowSelect', { id }), updateWorkflow: (id, version, change) => invoke('workflowUpdate', { id, version, change }),
  deleteWorkflow: id => invoke('workflowDelete', { id }),
  exportWorkflow: id => invoke('workflowExport', { id }), importWorkflow: () => invoke('workflowImport', undefined),
  learnPages: (id, version) => invoke('workflowLearnPages', { id, version }),
  previewItems: (id, stepId, show) => invoke('workflowPreviewItems', { id, stepId, show }),
  controlDownloads: (action, id) => invoke('downloadControl', { action, id }), setDownloadOptions: options => invoke('downloadSettings', options),
  chooseDownloadFolder: () => invoke('downloadFolderChoose', undefined), openDownloadFolder: () => invoke('downloadFolderOpen', undefined),
  showDownload: id => invoke('downloadShow', { id }), setMetadataLabels: labels => invoke('metadataLabels', { labels }),
  startProfile: url => invoke('profileStart', { url }), deleteProfile: id => invoke('profileDelete', { id }),
  reteachStep: (id, stepId) => invoke('workflowReteach', { id, stepId }), openScreenshot: name => invoke('screenshotOpen', { name }),
  dismissClipboard: () => invoke('clipboardDismiss', undefined),
  setSafety: settings => invoke('safetySettings', settings), setTray: settings => invoke('traySettings', settings),
  setAdBlock: settings => invoke('adblockSettings', settings),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
};
contextBridge.exposeInMainWorld('vestigium', bridge);
