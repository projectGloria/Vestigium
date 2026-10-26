import { app, BrowserWindow, clipboard, Menu, nativeImage, net, Notification, session, screen, dialog, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './store/db.js';
import { repositories } from './store/repositories.js';
import { Logger } from './logger.js';
import { createBrowserSession, denyPermissions } from './browser/session.js';
import { TabManager } from './browser/tabs.js';
import { RecordingSession } from './browser/recording.js';
import { WorkflowLibrary } from './engine/workflow-library.js';
import { WorkflowRunner } from './engine/workflow-runner.js';
import { FrameCommandBridge } from './engine/locator-resolver.js';
import { NetworkMonitor } from './browser/network.js';
import { AdBlocker, bundledListsDir } from './browser/ad-blocker.js';
import { ItemPreviewer } from './learn/item-preview.js';
import { DownloadQueue } from './downloads/queue.js';
import { DownloadStore } from './downloads/store.js';
import { findSevenZip } from './downloads/archive.js';
import { toItemMetadata } from './learn/metadata.js';
import { SiteProfiles } from './engine/site-profiles.js';
import { RunHistory } from './engine/run-history.js';
import { trayIconPng } from './tray-icon.js';
import { isBrowserUrl } from './validation.js';
import type { ShellState } from './ipc.js';
import { parseCli, USAGE } from './cli/args.js';
import { listProfiles, runCli } from './cli/run.js';
import { registerIpc } from './ipc.js';
import { CHANNELS } from '../shared/ipc.js';
import type { AppState, WindowBounds } from '../shared/types.js';

app.setName('Vestigium');
if (process.env.VESTIGIUM_USER_DATA) app.setPath('userData', resolve(process.env.VESTIGIUM_USER_DATA));
// Plan §8: `vestigium run …` / `vestigium profiles` use this same app without showing its window. Arguments follow
// the executable (packaged) or the app path (development); none means the normal window.
const cli = parseCli(process.argv.slice(app.isPackaged ? 1 : 2));
if (cli?.kind === 'help' || cli?.kind === 'error') {
  if (cli.kind === 'help') console.log(USAGE);
  else console.error(`${cli.message}\n\n${USAGE}`);
  app.exit(cli.kind === 'help' ? 0 : 2);
} else if (!app.requestSingleInstanceLock()) {
  // One profile, one process: the open window owns the database and the browser session.
  if (cli) {
    console.error('Vestigium is already open with this profile. Close its window first (or set VESTIGIUM_USER_DATA to use another profile).');
    app.exit(3);
  } else app.quit();
}
else void app.whenReady().then(start).catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  console.error(error);
  new Logger(join(app.getPath('userData'), 'logs')).write('error', `Startup failed: ${message}`);
  if (process.env.VESTIGIUM_TEST !== '1' && !cli) dialog.showErrorBox('Vestigium could not start', message);
  app.exit(cli ? 3 : 1);
});

async function start() {
  const userData = app.getPath('userData');
  const log = new Logger(join(userData, 'logs'));
  const db = openDatabase(join(userData, 'vestigium.sqlite'));
  const { settings, workflows: workflowRepository, siteProfiles: profileRepository, runLog } = repositories(db);
  const profiles = new SiteProfiles(profileRepository, log);
  const history = new RunHistory(runLog, db);
  // Failure screenshots (plan §6) live next to the profile; history records refer to them by file name only.
  const failures = join(userData, 'failures');
  // Shell-only state the IPC handlers change: a link offered from the clipboard, and a step being re-taught.
  const shell: ShellState = { clipboardUrl: null, reteach: null };
  // VESTIGIUM_DOWNLOADS lets tests (and isolated dev profiles) keep files out of the real Downloads folder.
  const defaultDownloads = process.env.VESTIGIUM_DOWNLOADS ? resolve(process.env.VESTIGIUM_DOWNLOADS) : join(app.getPath('downloads'), 'Vestigium');
  let downloads: DownloadQueue | undefined;
  const workflows = new WorkflowLibrary(workflowRepository, log);
  // The recorder needs the tab manager, which needs the session; hooks bind late to break the cycle.
  let recording: RecordingSession | undefined;
  let runner: WorkflowRunner | undefined;
  const browserSession = await createBrowserSession(userData, log, { onDownload: (contents, download) => {
    const recorded = recording?.onDownload(contents, download) ?? false;
    runner?.onDownload(contents, download);
    // A link renewal wants only the fresh URL; the job that asked for it continues its own .part file.
    if (runner?.claimRenewal(contents, download)) return;
    if (recorded) {
      log.write('info', 'Teaching: the download is recorded, not saved. Run the workflow to download.');
      return;
    }
    // A run's download belongs to the item being processed (whose details the runner already read); a manual
    // download belongs to the page it came from, whose details are read here first, briefly.
    const context = runner?.downloadContext(contents) ?? null;
    const page = download.referrer ? { url: download.referrer, title: download.pageTitle, sourcePage: '' } : null;
    const enqueue = (metadata?: Record<string, string>) => downloads?.enqueue({
      url: download.url, referrer: download.referrer, sourcePage: context?.item?.url ?? download.referrer,
      title: context?.item?.title ?? download.pageTitle, suggestedName: download.filename, mimeType: download.mimeType,
      item: context?.item ?? (page ? { ...page, metadata } : null), origin: context?.origin ?? null,
    });
    if (context?.item || !page || !downloads) return void enqueue();
    void bridge.query(contents, [], { kind: 'extract-metadata', labels: downloads.metadataLabels() }, 3000)
      // A tab that already moved on would describe another page: keep the download, drop those details.
      .then(answer => enqueue(answer.ok && answer.value.url === page.url ? toItemMetadata(answer.value) : undefined), () => enqueue());
  } });
  // The command line may point this run's downloads elsewhere (--output) or force them (--force); the saved settings stay.
  const downloadSettings = () => {
    const saved = settings.get('downloads');
    if (cli?.kind !== 'run') return saved;
    return { ...saved, ...(cli.output ? { directory: resolve(cli.output) } : {}), ...(cli.force ? { force: true } : {}) };
  };
  downloads = new DownloadQueue(new DownloadStore(db), downloadSettings, defaultDownloads, browserSession.fetcher, log,
    () => changed(), {
      // An expired link is renewed by redoing the step that produced it (only while no run is using the browser).
      resolve: async job => {
        const workflow = job.origin ? workflowRepository.get(job.origin.workflowId) : null;
        return workflow && runner ? runner.renew(workflow, job) : null;
      },
      notify: (title, body) => {
        if (process.env.VESTIGIUM_TEST !== '1' && Notification.isSupported()) new Notification({ title, body }).show();
      },
      sevenZip: findSevenZip(),
      labels: () => settings.get('metadata').labels,
    });
  // Loaded before the first tab opens, so the first page is already filtered. List refreshes go through the default
  // session (net.fetch): no site cookies. Not from the command line (a short run should not fetch 5 MB of lists),
  // nor when tests pin the lists (VESTIGIUM_FILTER_LISTS) or switch refreshing off (VESTIGIUM_FILTER_REFRESH=off).
  const refreshLists = !cli && !process.env.VESTIGIUM_FILTER_LISTS && process.env.VESTIGIUM_FILTER_REFRESH !== 'off';
  const adblock = new AdBlocker({ bundledDir: bundledListsDir(join(__dirname, '../..'), process.resourcesPath, app.isPackaged),
    cacheDir: join(userData, 'adblock'), log, enabled: settings.get('adblock').enabled, fetch: refreshLists ? url => net.fetch(url) : null });
  await adblock.load();
  const shellSession = session.fromPartition('vestigium-shell'); denyPermissions(shellSession);
  const savedBounds = settings.get('windowBounds');
  const onScreen = screen.getAllDisplays().some(({ workArea }) => savedBounds.x !== undefined && savedBounds.y !== undefined && savedBounds.x + savedBounds.width > workArea.x && savedBounds.x < workArea.x + workArea.width && savedBounds.y + savedBounds.height > workArea.y && savedBounds.y < workArea.y + workArea.height);
  const bounds: WindowBounds = onScreen ? savedBounds : { width: savedBounds.width, height: savedBounds.height };
  const window = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 640, title: 'Vestigium', show: false, backgroundColor: '#111916',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), session: shellSession, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
  window.setMenuBarVisibility(false);
  const shellUrl = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).href : pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // No shell.openExternal calls: custom protocols cannot launch external applications.
  let tabs: TabManager;
  let previewer: ItemPreviewer | undefined;
  const state = (): AppState => ({
    tabs: tabs?.list() ?? [], activeTabId: tabs?.activeId ?? 0, settings: settings.all(), logs: log.recent(),
    recording: recording?.status() ?? { active: false, events: 0 }, workflows: workflows.list(), selectedWorkflow: workflows.selected(),
    run: runner?.status() ?? null, itemPreview: previewer?.state() ?? null, downloads: downloads!.state(),
    profiles: profiles.summaries(workflows.list()), history: history.recent(), clipboardUrl: shell.clipboardUrl, reteach: shell.reteach,
    adblock: adblock.status(),
  });
  const changed = () => { if (!window.isDestroyed() && !window.webContents.isLoadingMainFrame()) window.webContents.send(CHANNELS.changed, state()); };
  tabs = new TabManager(window, browserSession.session, log, changed, url => settings.set('lastUrl', url), {
    onNavigate: (contents, url, details) => {
      recording?.onNavigate(contents, url, details);
      runner?.onNavigate(contents, details);
    },
    onPopup: (popup, opener) => {
      recording?.onPopup(popup, opener);
      runner?.onPopup(popup, opener);
    },
  }, (url, openerUrl) => adblock.blocksPopup(url, openerUrl));
  recording = new RecordingSession(browserSession.session, tabs, log, changed, join(__dirname, '../preload/recorder.cjs'));
  const bridge = new FrameCommandBridge();
  const network = new NetworkMonitor(browserSession.session, adblock);
  runner = new WorkflowRunner(tabs, bridge, network, log, changed, () => settings.get('run'),
    (workflowId, stepId, locators, reason) => { workflows.heal(workflowId, stepId, locators, reason); changed(); }, downloads);
  // Plan §4: when a run needs a person (captcha, login, countdown), bring the window forward and say so.
  runner.onAttention = (_contents, message) => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.flashFrame(true);
    if (process.env.VESTIGIUM_TEST !== '1' && Notification.isSupported()) new Notification({ title: 'Vestigium needs you', body: message }).show();
  };
  window.on('focus', () => window.flashFrame(false));
  runner.onFinished = run => {
    history.add(run);
    profiles.grade(run.workflowId, run);
  };
  runner.saveScreenshot = async png => {
    const name = `${randomUUID()}.png`;
    await mkdir(failures, { recursive: true });
    await writeFile(join(failures, name), png);
    return name;
  };
  runner.safety = () => settings.get('safety');
  // Plan §6, "paste/auto-detect from clipboard": when the window gets focus, an http(s) link on the clipboard is
  // offered once in the tab strip. Nothing else from the clipboard is kept or logged.
  let lastClipboard = '';
  window.on('focus', async () => {
    const text = (await clipboard.readText()).trim();
    if (!text || text === lastClipboard || text.length > 2000 || /\s/.test(text) || !isBrowserUrl(text) || text === 'about:blank') return;
    lastClipboard = text;
    if (tabs.list().some(tab => tab.url === text)) return;
    shell.clipboardUrl = text;
    changed();
  });
  // Plan §6: a tray icon, and "minimize while running" hides the window there while a run or downloads are active.
  // Not for the command line, which has no window to come back to.
  const tray = cli ? null : new Tray(nativeImage.createFromBuffer(trayIconPng()));
  tray?.setToolTip('Vestigium');
  const showWindow = () => { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Vestigium', click: showWindow },
    { label: 'Pause all downloads', click: () => downloads?.pause(null) },
    { label: 'Resume all downloads', click: () => downloads?.resume(null) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray?.on('click', showWindow);
  const busy = () => Boolean(runner?.isRunning()) || (downloads ? downloads.state().counts.running + downloads.state().counts.queued > 0 : false);
  window.on('minimize', () => {
    if (!settings.get('tray').minimizeToTray || !busy()) return;
    if (!tray) return;
    window.hide();
    tray.setToolTip(runner?.isRunning() ? 'Vestigium · running' : 'Vestigium · downloading');
    log.write('info', 'Vestigium keeps working in the tray. Click its icon to show the window.');
  });
  previewer = new ItemPreviewer(tabs, bridge, log);
  const removeIpc = registerIpc(window, shellUrl, { tabs, settings, recording, workflows, runner, bridge, previewer, downloads, profiles, adblock, shell, failures, log }, state, changed);
  log.onChange = changed;
  const rememberBounds = () => { if (!window.isDestroyed() && !window.isMinimized()) settings.set('windowBounds', window.getNormalBounds()); };
  window.on('resized', rememberBounds); window.on('moved', rememberBounds);
  let shutdown: Promise<void> | undefined; let finished = false;
  let exitCode: number | null = null;
  // Each shutdown step is isolated: a failing step is logged, but can never leave `finished` unset,
  // which would keep the close prevented and the app impossible to quit.
  const note = (level: 'info' | 'error', message: string) => {
    try { log.write(level, message); } catch { /* a full disk must not keep the app from quitting */ }
  };
  const attempt = (label: string, action: () => void) => {
    try { action(); } catch (error) { note('error', `Shutdown step "${label}" failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
  };
  // `finally` guarantees the quit: a shutdown that throws must never leave the close prevented (a hung app).
  const stop = () => shutdown ??= (async () => {
    // First: shutdown log lines must not rebuild and push UI state (that reads the DB) while things are torn down.
    log.onChange = undefined;
    try {
      attempt('save window', rememberBounds);
      try { await browserSession.save(); note('info', 'Browser session saved.'); }
      catch { note('error', 'Browser session could not be saved. Some logins may require signing in again.'); }
      attempt('remove IPC', removeIpc);
      // Awaited: a stopped run writes its history record, which must happen before the database closes.
      try { await runner?.stopAndSettle(5000); }
      catch (error) { note('error', `Shutdown step "stop run" failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
      // Before the DB closes: running transfers are stored as queued, with their byte counts, and resume next start.
      attempt('stop downloads', () => downloads?.dispose());
      attempt('stop replay bridge', () => bridge.dispose());
      attempt('stop network monitor', () => network.dispose());
      attempt('stop ad blocker', () => adblock.dispose());
      attempt('stop recorder', () => recording?.dispose());
      attempt('close tabs', () => tabs.dispose());
      attempt('remove tray icon', () => tray?.destroy());
      note('info', 'Vestigium closed.');
      attempt('close database', () => db.close());
    } finally {
      finished = true; window.destroy();
      // The command line's result is its exit code.
      if (exitCode !== null) app.exit(exitCode);
      else app.quit();
    }
  })();
  // Only preventDefault runs inside the event: shutdown itself starts on a fresh stack. Quit can be requested from
  // anywhere (a test's app.quit() arrives through the inspector, in the middle of other work), and shutdown uses the DB.
  window.on('close', event => { if (!finished) { event.preventDefault(); setImmediate(() => void stop()); } });
  app.on('before-quit', event => { if (!finished) { event.preventDefault(); setImmediate(() => void stop()); } });
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
  // The command line keeps the window hidden; it appears only when a run needs a person (onAttention).
  window.once('ready-to-show', () => { if (!cli) window.show(); });
  await window.loadURL(shellUrl);
  tabs.create(settings.get('lastUrl'));
  downloads.start();
  adblock.start();
  log.write('info', cli ? 'Vestigium command line started.' : 'Vestigium opened. Database migrations applied; persistent browser profile ready.');
  if (cli) {
    const print = (line: string) => console.log(line);
    log.onWrite = entry => print(`${entry.level === 'info' ? '' : `${entry.level.toUpperCase()}: `}${entry.message}`);
    exitCode = cli.kind === 'profiles' ? listProfiles(profiles, print) : cli.kind !== 'run' ? 2
      : await runCli(cli, { profiles, runner, downloads, load: id => { workflows.select(id); return workflows.selected()!; }, tab: () => tabs.active() }, print)
        .catch(error => { print(`The run could not finish: ${error instanceof Error ? error.message : 'unknown error'}`); return 1; });
    log.onWrite = undefined;
    setImmediate(() => void stop());
  }
}
