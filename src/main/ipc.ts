import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { CHANNELS, type Command, type Result } from '../shared/ipc.js';
import type { AppState } from '../shared/types.js';
import type { TabManager } from './browser/tabs.js';
import type { RecordingSession } from './browser/recording.js';
import type { WorkflowLibrary } from './engine/workflow-library.js';
import type { WorkflowRunner } from './engine/workflow-runner.js';
import type { FrameCommandBridge } from './engine/locator-resolver.js';
import type { ItemPreviewer } from './learn/item-preview.js';
import type { DownloadQueue } from './downloads/queue.js';
import type { SiteProfiles } from './engine/site-profiles.js';
import type { AdBlocker } from './browser/ad-blocker.js';
import { allSteps } from './engine/steps.js';
import type { AppState as SharedAppState } from '../shared/types.js';
import { join } from 'node:path';

// Shell-only state changed by these handlers and shown in AppState.
export interface ShellState { clipboardUrl: string | null; reteach: SharedAppState['reteach'] }
import { learnPagination } from './learn/learner.js';
import type { SettingsRepository } from './store/repositories.js';
import type { Logger } from './logger.js';
import { UserFacingError } from './errors.js';
import { validatePayload } from './validation.js';
import { exportFileName } from './engine/workflow-edit.js';

const JSON_FILTER = [{ name: 'Vestigium workflow', extensions: ['json'] }];

export interface IpcServices {
  tabs: TabManager;
  settings: SettingsRepository;
  recording: RecordingSession;
  workflows: WorkflowLibrary;
  runner: WorkflowRunner;
  bridge: FrameCommandBridge;
  previewer: ItemPreviewer;
  downloads: DownloadQueue;
  profiles: SiteProfiles;
  adblock: AdBlocker;
  shell: ShellState;
  // Folder of failure screenshots.
  failures: string;
  log: Logger;
}

export function registerIpc(window: BrowserWindow, shellUrl: string, services: IpcServices, state: () => AppState, changed: () => void) {
  const { tabs, settings, recording, workflows, runner, bridge, previewer, downloads, profiles, adblock, shell: shellState, failures, log } = services;
  const commands = Object.keys(CHANNELS).filter(key => key !== 'changed') as Command[];
  // Editing or deleting the workflow that is running would change steps under the runner's feet.
  const busy = (id: string) => {
    if (runner.isRunning() && runner.status()?.workflowId === id) throw new UserFacingError('Stop the run before changing this workflow.');
  };
  for (const command of commands) {
    ipcMain.handle(CHANNELS[command], async (event, payload: unknown): Promise<Result> => {
      // Only the exact shell document may call the bridge; browser pages and their frames never can.
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== shellUrl) {
        log.write('warn', 'Rejected IPC from an untrusted frame.');
        return { ok: false, error: 'Access denied.' };
      }
      try {
        validatePayload(command, payload);
        switch (command) {
          case 'state': break; // Read-only: the reply below carries the current state.
          case 'navigate': {
            const { url } = validatePayload('navigate', payload);
            tabs.navigate(url);
            if (shellState.clipboardUrl === url) shellState.clipboardUrl = null;
            break;
          }
          case 'back': tabs.back(); break;
          case 'forward': tabs.forward(); break;
          case 'reload': tabs.reload(); break;
          case 'newTab': tabs.create(); break;
          case 'selectTab': tabs.select(validatePayload('selectTab', payload).id); break;
          case 'closeTab': tabs.close(validatePayload('closeTab', payload).id); break;
          case 'theme': settings.set('theme', validatePayload('theme', payload).theme); break;
          case 'recordStart':
            // A run drives the same tabs; recording it would capture the replay's own synthetic actions.
            if (runner.isRunning()) throw new UserFacingError('Stop the running workflow before recording.');
            recording.start();
            break;
          case 'recordStop': {
            const result = await recording.stop();
            const reteach = shellState.reteach;
            if (reteach) {
              shellState.reteach = null;
              // The short recording's element that matches the broken step: a download for a download step, else a click.
              const original = workflows.selected()?.id === reteach.workflowId ? workflows.selected() : null;
              const broken = original ? [...allSteps(original.steps)].find(step => step.id === reteach.stepId) : null;
              const recorded = [...allSteps(result.steps)].filter(step => step.type === 'click' || step.type === 'download' || step.type === 'select' || step.type === 'type');
              const taught = recorded.find(step => step.type === broken?.type) ?? recorded[0];
              if (!taught) throw new UserFacingError('Nothing was clicked. Re-teach again and click the right element in the page.');
              workflows.select(reteach.workflowId);
              workflows.reteach(reteach.workflowId, reteach.stepId, taught);
              log.write('info', `Re-taught "${reteach.label}": it now finds ${taught.locators[0] ? `${taught.locators[0].strategy}: ${taught.locators[0].value}` : 'the element you clicked'}.`);
              break;
            }
            const workflow = workflows.createFromRecording(result);
            log.write('info', `Saved workflow "${workflow.name}" with ${workflow.steps.length} steps.`);
            // A generalized recording teaches its site: next time a URL and Start are enough.
            const profile = profiles.learn(workflow, settings.get('run').hostIntervalMs);
            if (profile) workflows.link(workflow.id, profile.id);
            break;
          }
          case 'workflowRun': {
            if (recording.status().active) throw new UserFacingError('Stop recording before running a workflow.');
            const { id, mode } = validatePayload('workflowRun', payload);
            previewer.forget();
            workflows.select(id);
            runner.start(workflows.selected()!, mode);
            break;
          }
          case 'runStop': runner.stop(); break;
          case 'runPause': runner.pause(); break;
          case 'runResume': runner.resume(); break;
          case 'runNext': runner.next(); break;
          case 'runSettings': settings.set('run', validatePayload('runSettings', payload)); break;
          case 'workflowSelect': {
            const { id } = validatePayload('workflowSelect', payload);
            workflows.select(id);
            previewer.forget(id);
            break;
          }
          case 'workflowUpdate': {
            const { id, version, change } = validatePayload('workflowUpdate', payload);
            busy(id);
            const updated = workflows.update(id, version, change);
            if (change.kind === 'exclude-item') await previewer.refresh(updated);
            break;
          }
          case 'workflowDelete': {
            const { id } = validatePayload('workflowDelete', payload);
            busy(id);
            previewer.forget();
            workflows.remove(id);
            log.write('info', 'Workflow deleted.');
            break;
          }
          case 'workflowExport': {
            const { id } = validatePayload('workflowExport', payload);
            workflows.select(id);
            const target = await dialog.showSaveDialog(window, {
              title: 'Export workflow', defaultPath: exportFileName(workflows.selected()!.name), filters: JSON_FILTER,
            });
            if (target.canceled || !target.filePath) break;
            await workflows.exportTo(id, target.filePath);
            log.write('info', `Exported workflow "${workflows.selected()!.name}".`);
            break;
          }
          case 'workflowImport': {
            const source = await dialog.showOpenDialog(window, { title: 'Import workflow', properties: ['openFile'], filters: JSON_FILTER });
            if (source.canceled || source.filePaths.length === 0) break;
            const imported = await workflows.importFrom(source.filePaths[0]);
            log.write('info', `Imported workflow "${imported.name}" with ${imported.steps.length} steps.`);
            break;
          }
          case 'workflowLearnPages': {
            const { id, version } = validatePayload('workflowLearnPages', payload);
            busy(id);
            if (recording.status().active) throw new UserFacingError('Stop recording first.');
            const pattern = await learnPagination(bridge, tabs.active());
            workflows.addPageLoop(id, version, pattern);
            log.write('info', `Learned the list's pagination. ${pattern.description}`);
            break;
          }
          case 'workflowPreviewItems': {
            const { id, stepId, show } = validatePayload('workflowPreviewItems', payload);
            if (!show) {
              await previewer.hide();
              break;
            }
            if (runner.isRunning()) throw new UserFacingError('Stop the run before previewing items; the run uses the list tab.');
            if (recording.status().active) throw new UserFacingError('Stop recording first.');
            workflows.select(id);
            await previewer.show(workflows.selected()!, stepId);
            break;
          }
          case 'downloadControl': {
            const { action, id } = validatePayload('downloadControl', payload);
            downloads[action](id);
            break;
          }
          case 'downloadSettings':
            settings.set('downloads', { ...validatePayload('downloadSettings', payload), directory: settings.get('downloads').directory });
            break;
          case 'downloadFolderChoose': {
            const chosen = await dialog.showOpenDialog(window, { title: 'Download folder', defaultPath: downloads.directory(), properties: ['openDirectory', 'createDirectory'] });
            if (chosen.canceled || chosen.filePaths.length === 0) break;
            settings.set('downloads', { ...settings.get('downloads'), directory: chosen.filePaths[0] });
            log.write('info', `Downloads now go to ${chosen.filePaths[0]}. Files already downloaded stay where they are.`);
            break;
          }
          case 'downloadFolderOpen': {
            await mkdir(downloads.directory(), { recursive: true });
            // shell.openPath opens a local folder in Explorer; no URL or external protocol is involved.
            const problem = await shell.openPath(downloads.directory());
            if (problem) throw new UserFacingError(`The download folder could not be opened: ${problem}`);
            break;
          }
          case 'downloadShow': {
            const { id } = validatePayload('downloadShow', payload);
            const path = downloads.state().rows.find(row => row.id === id)?.finalPath;
            if (!path || !existsSync(path)) throw new UserFacingError('That file is no longer there.');
            shell.showItemInFolder(path);
            break;
          }
          case 'profileStart': {
            if (recording.status().active) throw new UserFacingError('Stop recording before starting.');
            if (runner.isRunning()) throw new UserFacingError('A workflow is already running. Stop it first.');
            const requested = validatePayload('profileStart', payload).url;
            const url = requested ?? tabs.active().getURL();
            if (!/^https?:/.test(url)) throw new UserFacingError('Open a list page first (or paste its address), then press Start.');
            const { profile, workflow } = profiles.plan(url, id => { workflows.select(id); return workflows.selected()!; });
            previewer.forget();
            log.write('info', `Starting the ${profile.domain} profile on ${url}.`);
            runner.start(workflow);
            break;
          }
          case 'profileDelete': {
            profiles.remove(validatePayload('profileDelete', payload).id);
            log.write('info', 'Site profile deleted. Its workflow is kept.');
            break;
          }
          case 'workflowReteach': {
            const { id, stepId } = validatePayload('workflowReteach', payload);
            busy(id);
            if (recording.status().active) throw new UserFacingError('Stop recording first.');
            workflows.select(id);
            const step = [...allSteps(workflows.selected()!.steps)].find(candidate => candidate.id === stepId);
            if (!step || !['click', 'download', 'select', 'type'].includes(step.type)) throw new UserFacingError('Only a click, download, select or typing step can be re-taught.');
            // Open the page where it failed, when the last run knows it.
            const failure = runner.status()?.workflowId === id && runner.status()?.failure?.stepId === stepId ? runner.status()!.failure : null;
            if (failure) tabs.navigate(failure.url);
            shellState.reteach = { workflowId: id, stepId, label: step.label };
            recording.start();
            log.write('info', `Re-teaching "${step.label}": click the right element in the page, then press Stop recording.`);
            break;
          }
          case 'screenshotOpen': {
            const { name } = validatePayload('screenshotOpen', payload);
            const path = join(failures, name);
            if (!existsSync(path)) throw new UserFacingError('That screenshot is no longer there.');
            const problem = await shell.openPath(path);
            if (problem) throw new UserFacingError(`The screenshot could not be opened: ${problem}`);
            break;
          }
          case 'clipboardDismiss': shellState.clipboardUrl = null; break;
          case 'safetySettings': settings.set('safety', validatePayload('safetySettings', payload)); break;
          case 'traySettings': settings.set('tray', validatePayload('traySettings', payload)); break;
          case 'adblockSettings': {
            const value = validatePayload('adblockSettings', payload);
            settings.set('adblock', value);
            // The blocker keeps its own copy: it is asked on every request, and a settings read is a DB query.
            adblock.setEnabled(value.enabled);
            break;
          }
          case 'metadataLabels': {
            const { labels } = validatePayload('metadataLabels', payload);
            // Case-insensitive duplicates would only shadow each other.
            const unique = labels.filter((label, index) => labels.findIndex(other => other.toLowerCase() === label.toLowerCase()) === index);
            settings.set('metadata', { labels: unique });
            break;
          }
          default: {
            // Compile-time guard: adding a command to CHANNELS without handling it here fails typecheck.
            const unhandled: never = command;
            throw new Error(`Unhandled command ${String(unhandled)}`);
          }
        }
        changed();
        return { ok: true, state: state() };
      } catch (error) {
        // Messages written for users pass through; anything else is an internal detail.
        if (error instanceof UserFacingError) {
          log.write('warn', error.message);
          return { ok: false, error: error.message };
        }
        log.write('warn', `Rejected or failed ${command} request.`);
        return { ok: false, error: 'Request rejected. Check the URL or selected tab and try again.' };
      }
    });
  }
  return () => {
    for (const command of commands) ipcMain.removeHandler(CHANNELS[command]);
  };
}
