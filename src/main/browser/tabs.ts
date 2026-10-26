import { WebContentsView, type BrowserWindow, type Session, type WebContents, type WebPreferences } from 'electron';
import type { BrowserTab } from '../../shared/types.js';
import { LAYOUT } from '../../shared/ipc.js';
import { isBrowserUrl } from '../validation.js';
import type { Logger } from '../logger.js';

// Observers for the recorder. The recorder script itself is a session-registered preload, not injected from here.
export interface BrowserHooks {
  // fromAddressBar: started from the shell (URL box, Back/Forward/Reload), not by the page.
  // status: the HTTP status of a new document (0 for in-page navigations), so a link that leads to an error page is
  // recognized at once instead of waiting for a download that will never come.
  onNavigate?: (contents: WebContents, url: string, details: { inPage: boolean; fromAddressBar: boolean; status: number }) => void;
  onPopup?: (popup: WebContents, opener: WebContents) => void;
}
export class TabManager {
  private views = new Map<number, WebContentsView>();
  private errors = new Map<number, string>();
  // Tabs whose next main-frame navigation was requested by the shell rather than the page.
  private userNavigations = new Set<number>();
  activeId = 0;
  private disposed = false;
  // Last non-zero content size (see layout).
  private contentSize: [number, number] = [1, 1];
  constructor(private window: BrowserWindow, private session: Session, private log: Logger,
    private changed: () => void, private rememberUrl: (url: string) => void, private hooks: BrowserHooks = {},
    // The ad blocker's verdict on a popup (its URL, the opener's page). Popunder ads open as popups and would
    // otherwise become managed tabs that take focus in the middle of a run.
    private popupBlocked: (url: string, openerUrl: string) => boolean = () => false) {
    window.on('resize', () => this.layout());
    window.on('restore', () => this.layout());
  }
  private preferences(): WebPreferences {
    return { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
      // With sandbox on this adds no Node.js; it only lets the session's recorder preload run inside iframes too.
      nodeIntegrationInSubFrames: true, webviewTag: false, webSecurity: true };
  }
  create(url = 'about:blank', existing?: WebContents, opener?: WebContents): WebContentsView {
    const view = new WebContentsView({ ...(existing ? { webContents: existing } : {}), webPreferences: this.preferences() });
    const contents = view.webContents;
    this.views.set(contents.id, view);
    contents.setWindowOpenHandler(details => {
      if (!isBrowserUrl(details.url)) { this.log.write('warn', 'Blocked popup using an unsupported protocol.'); return { action: 'deny' }; }
      if (this.popupBlocked(details.url, contents.getURL())) { this.log.write('info', 'Blocked an ad popup.'); return { action: 'deny' }; }
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: this.preferences() },
        // Electron supplies the pre-created contents here, but its public options type omits it.
        createWindow: options => this.create('about:blank', (options as typeof options & { webContents?: WebContents }).webContents, contents).webContents };
    });
    const block = (event: Electron.Event, url: string) => {
      if (!isBrowserUrl(url)) { event.preventDefault(); this.log.write('warn', 'Blocked navigation using an unsupported protocol.'); }
    };
    contents.on('will-navigate', block);
    contents.on('will-redirect', block);
    contents.on('will-frame-navigate', details => { if (details.isMainFrame) block(details, details.url); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('content-bounds-updated', event => event.preventDefault());
    contents.on('did-start-loading', () => { this.errors.delete(contents.id); this.emit(); });
    contents.on('did-stop-loading', () => this.emit());
    contents.on('page-title-updated', () => this.emit());
    const navigated = (url: string, inPage: boolean, status = 0) => {
      if (this.activeId === contents.id && isBrowserUrl(url)) this.rememberUrl(url);
      const fromAddressBar = !inPage && this.userNavigations.delete(contents.id);
      this.hooks.onNavigate?.(contents, url, { inPage, fromAddressBar, status });
      this.emit();
    };
    contents.on('did-navigate', (_event, url, status) => navigated(url, false, status));
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) navigated(url, true); });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.userNavigations.delete(contents.id);
      if (!mainFrame || code === -3) return;
      this.errors.set(contents.id, `Page failed to load: ${description} (${code}).`);
      this.log.write('error', `Browser page failed to load: ${description} (${code}).`); this.emit();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.errors.set(contents.id, `Browser process stopped: ${details.reason}. Reload to retry.`); this.log.write('error', `Browser process stopped: ${details.reason}.`); this.emit();
    });
    contents.on('destroyed', () => {
      this.views.delete(contents.id); this.errors.delete(contents.id); this.userNavigations.delete(contents.id);
      if (!this.disposed && this.activeId === contents.id) this.selectOrCreate();
      this.emit();
    });
    this.select(contents.id);
    if (opener) this.hooks.onPopup?.(contents, opener);
    if (!existing && url !== 'about:blank') {
      this.rememberUrl(url);
      void contents.loadURL(url).catch(() => {}); // did-fail-load reports readable failures.
    }
    return view;
  }
  private emit() { if (!this.disposed) this.changed(); }
  list(): BrowserTab[] {
    return [...this.views.values()].filter(view => !view.webContents.isDestroyed()).map(({ webContents: contents }) => ({
      id: contents.id, title: contents.getTitle() || 'New tab', url: contents.getURL() || 'about:blank', loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), error: this.errors.get(contents.id) ?? null,
    }));
  }
  active(): WebContents { const view = this.views.get(this.activeId); if (!view) throw new Error('No active browser tab.'); return view.webContents; }
  navigate(url: string) {
    if (!isBrowserUrl(url)) throw new Error('Unsupported URL.');
    this.rememberUrl(url);
    this.userNavigations.add(this.active().id);
    void this.active().loadURL(url).catch(() => {});
  }
  back() { const contents = this.active(); if (contents.navigationHistory.canGoBack()) { this.userNavigations.add(contents.id); contents.navigationHistory.goBack(); } }
  forward() { const contents = this.active(); if (contents.navigationHistory.canGoForward()) { this.userNavigations.add(contents.id); contents.navigationHistory.goForward(); } }
  reload() { const contents = this.active(); this.userNavigations.add(contents.id); contents.reload(); }
  // Managed tab lookup for IPC from browser pages (the recorder): unknown senders are ignored.
  get(id: number): WebContents | null { const view = this.views.get(id); return view && !view.webContents.isDestroyed() ? view.webContents : null; }
  select(id: number) {
    const view = this.views.get(id); if (!view) throw new Error('Browser tab no longer exists.');
    for (const child of this.views.values()) if (child !== view) this.window.contentView.removeChildView(child);
    this.window.contentView.addChildView(view); this.activeId = id; this.layout();
    const url = view.webContents.getURL() || 'about:blank'; if (isBrowserUrl(url)) this.rememberUrl(url);
    this.emit();
  }
  close(id: number) {
    const view = this.views.get(id); if (!view) throw new Error('Browser tab no longer exists.');
    this.window.contentView.removeChildView(view); view.webContents.close({ waitForBeforeUnload: false });
  }
  private selectOrCreate() { const id = this.views.keys().next().value; if (id) this.select(id); else this.create(); }
  layout() {
    if (this.window.isDestroyed()) return;
    // A minimized window reports a 0×0 content size; sizing views from it would shrink every tab to 1×1 until the next
    // resize. Keep the last real size; 'restore' lays out again.
    const [currentWidth, currentHeight] = this.window.getContentSize();
    if (currentWidth > 0 && currentHeight > 0) this.contentSize = [currentWidth, currentHeight];
    const [width, height] = this.contentSize;
    this.views.get(this.activeId)?.setBounds({ x: LAYOUT.sidebar, y: LAYOUT.toolbar + LAYOUT.tabs,
      width: Math.max(1, width - LAYOUT.sidebar), height: Math.max(1, height - LAYOUT.toolbar - LAYOUT.tabs - LAYOUT.bottom) });
  }
  // Chromium gives tabs created while the window is minimized (or hidden) a 0×0 viewport until it is shown again, so
  // OS-level clicks in them hit nothing. The runner checks this before choosing real input.
  hidden(): boolean { return this.window.isDestroyed() || this.window.isMinimized() || !this.window.isVisible(); }
  dispose() { this.disposed = true; for (const view of this.views.values()) { this.window.contentView.removeChildView(view); view.webContents.close({ waitForBeforeUnload: false }); } this.views.clear(); }
}
