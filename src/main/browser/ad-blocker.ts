import { ENGINE_VERSION, FiltersEngine, Request, type RequestType } from '@ghostery/adblocker';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AdBlockStatus } from '../../shared/types.js';
import { FILTER_LISTS } from './filter-lists.js';

// Network-level ad and tracker blocking for browser tabs, driven by EasyList/uBlock filter lists through Ghostery's
// engine. Only network filters are loaded: no cosmetic filters, no scriptlets, nothing injected into pages, so the
// recorder (the only script pages get) sees the page's own DOM. Blocked ads leave empty slots; that is the trade.
//
// The engine is matched inside NetworkMonitor's onBeforeRequest: Electron allows one listener per webRequest event
// per session, so a second listener (Ghostery's ElectronBlocker) would silently replace the network-idle tracking.
//
// Where the filters come from, in order: the cached engine in userData (a serialized engine loads in milliseconds),
// else the lists bundled with the app (parsing them takes about half a second), which are then cached. The lists
// are refreshed weekly from the publisher; a failed or suspicious refresh keeps the current engine.

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60_000;
const CONFIG = { loadCosmeticFilters: false, loadNetworkFilters: true, loadCSPFilters: false, enableHtmlFiltering: false, loadExceptionFilters: true };

// What the blocker needs from Electron's onBeforeRequest details (kept structural so tests need no Electron).
export interface RequestDetails { url: string; resourceType: string; webContentsId?: number; referrer: string; topUrl: string | null }
export type Decision = { cancel: true } | { redirectURL: string } | null;
export interface AdBlockerOptions {
  bundledDir: string; cacheDir: string; log: Logger;
  enabled: boolean;
  // Null when lists must not be fetched (tests, the command line); the bundled or cached lists are used as they are.
  fetch: ((url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>) | null;
  now?: () => number;
}
interface CacheMeta { schemaVersion: 1; engineVersion: number; listsUpdated: string; filters: number }

const http = /^https?:/i;
const toRequestType = (type: string): RequestType => type === 'webSocket' ? 'websocket' : (type as RequestType);

export class AdBlocker {
  private engine: FiltersEngine | null = null;
  private listsUpdated: string | null = null;
  private filters = 0;
  private blocked = 0;
  private enabled: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private now: () => number;

  constructor(private options: AdBlockerOptions) { this.enabled = options.enabled; this.now = options.now ?? Date.now; }

  async load() {
    const cached = await this.readCache();
    const bundledDate = await this.bundledDate();
    // A refreshed cache is newer than the bundle; after an app update the bundle can be the newer one.
    if (cached && (!bundledDate || cached.meta.listsUpdated >= bundledDate)) {
      this.use(cached.engine, cached.meta.listsUpdated);
      this.options.log.write('info', `Ad blocking ready: ${this.filters} filters (lists from ${cached.meta.listsUpdated.slice(0, 10)}).`);
      return;
    }
    const text = bundledDate ? await this.readBundled() : null;
    if (!bundledDate || !text) { this.options.log.write('warn', 'Ad blocking is unavailable: no filter lists were found.'); return; }
    this.use(FiltersEngine.parse(text, CONFIG), bundledDate);
    await this.writeCache().catch(() => this.options.log.write('warn', 'Ad blocking: the filter cache could not be written.'));
    this.options.log.write('info', `Ad blocking ready: ${this.filters} filters (bundled lists from ${this.listsUpdated!.slice(0, 10)}).`);
  }

  private use(engine: FiltersEngine, listsUpdated: string) {
    this.engine = engine; this.listsUpdated = listsUpdated; this.filters = engine.getFilters().networkFilters.length;
  }

  private async readCache(): Promise<{ engine: FiltersEngine; meta: CacheMeta } | null> {
    try {
      const meta = JSON.parse(await readFile(join(this.options.cacheDir, 'engine.json'), 'utf8')) as CacheMeta;
      // A cache written by another engine version cannot be read (deserialize would throw); rebuild it from lists.
      if (meta.schemaVersion !== 1 || meta.engineVersion !== ENGINE_VERSION || typeof meta.listsUpdated !== 'string') return null;
      return { engine: FiltersEngine.deserialize(await readFile(join(this.options.cacheDir, 'engine.bin'))), meta };
    } catch { return null; }
  }

  // The bundle's date comes from its manifest; the 5–6 MB of list text is read only when it will be parsed.
  private async bundledDate(): Promise<string | null> {
    try {
      const { fetchedAt } = JSON.parse(await readFile(join(this.options.bundledDir, 'manifest.json'), 'utf8')) as { fetchedAt?: unknown };
      return typeof fetchedAt === 'string' && !Number.isNaN(Date.parse(fetchedAt)) ? fetchedAt : null;
    } catch { return null; }
  }

  private async readBundled(): Promise<string | null> {
    try {
      const names = (await readdir(this.options.bundledDir)).filter(name => name.endsWith('.txt')).sort();
      if (!names.length) return null;
      return (await Promise.all(names.map(name => readFile(join(this.options.bundledDir, name), 'utf8')))).join('\n');
    } catch { return null; }
  }

  private async writeCache() {
    if (!this.engine || !this.listsUpdated) return;
    await mkdir(this.options.cacheDir, { recursive: true });
    const meta: CacheMeta = { schemaVersion: 1, engineVersion: ENGINE_VERSION, listsUpdated: this.listsUpdated, filters: this.filters };
    // Each file is replaced atomically, engine first. A crash between the two leaves the new engine with the old
    // date, which only makes the next refresh come sooner.
    const bin = join(this.options.cacheDir, 'engine.bin');
    await writeFile(`${bin}.tmp`, this.engine.serialize()); await rename(`${bin}.tmp`, bin);
    const json = join(this.options.cacheDir, 'engine.json');
    await writeFile(`${json}.tmp`, JSON.stringify(meta)); await rename(`${json}.tmp`, json);
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.options.log.write('info', enabled ? 'Ad blocking turned on. Reload open pages to apply it.' : 'Ad blocking turned off. Reload open pages to see their ads again.');
  }

  // Only requests made by pages in browser tabs: the download queue's own fetches carry no webContentsId and are
  // never blocked (a file the person asked for must arrive even from a host on a list). Top-level navigations are
  // left alone too: typing or following a link to a page is a person's (or a workflow's) choice; popups opening
  // such pages are stopped separately (blocksPopup).
  decide(details: RequestDetails): Decision {
    if (!this.enabled || !this.engine || details.webContentsId === undefined) return null;
    if (details.resourceType === 'mainFrame' || !http.test(details.url)) return null;
    const result = this.engine.match(Request.fromRawDetails({
      url: details.url, sourceUrl: details.topUrl ?? details.referrer, type: toRequestType(details.resourceType),
    }));
    if (result.redirect) { this.blocked++; return { redirectURL: result.redirect.dataUrl }; }
    if (result.match) { this.blocked++; return { cancel: true }; }
    return null;
  }

  // A popup is judged like the page it would load. Popunder networks open their own landing or redirect URLs,
  // which the lists block by host.
  blocksPopup(url: string, openerUrl: string): boolean {
    if (!this.enabled || !this.engine || !http.test(url)) return false;
    const blocked = this.engine.match(Request.fromRawDetails({ url, sourceUrl: openerUrl, type: 'main_frame' })).match;
    if (blocked) this.blocked++;
    return blocked;
  }

  status(): AdBlockStatus {
    return { enabled: this.enabled, filters: this.filters, listsUpdated: this.listsUpdated, blocked: this.blocked };
  }

  // Checks now and then whether the lists are a week old; refreshes them in the background when they are.
  start() {
    if (!this.options.fetch) return;
    const check = (delay: number) => {
      this.timer = setTimeout(() => { void this.refresh().finally(() => { if (this.timer) check(CHECK_EVERY_MS); }); }, delay);
      this.timer.unref?.();
    };
    check(FIRST_CHECK_MS);
  }

  // Resolves true when new lists are in use. `force` skips the age check.
  refresh(force = false): Promise<boolean> {
    return this.refreshing ??= this.fetchLists(force).finally(() => { this.refreshing = null; });
  }

  private async fetchLists(force: boolean): Promise<boolean> {
    const fetch = this.options.fetch;
    if (!fetch) return false;
    if (!force && this.listsUpdated && this.now() - Date.parse(this.listsUpdated) < REFRESH_AFTER_MS) return false;
    try {
      const texts: string[] = [];
      for (const list of FILTER_LISTS) {
        const response = await fetch(list.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim()) throw new Error('an empty list');
        texts.push(text);
      }
      const engine = FiltersEngine.parse(texts.join('\n'), CONFIG);
      const filters = engine.getFilters().networkFilters.length;
      // A truncated download or an error page served as a list would quietly weaken blocking; keep what works.
      if (filters < this.filters / 2) throw new Error(`only ${filters} filters`);
      this.use(engine, new Date(this.now()).toISOString());
      await this.writeCache();
      this.options.log.write('info', `Ad blocking lists updated: ${filters} filters.`);
      return true;
    } catch (error) {
      this.options.log.write('warn', `Ad blocking lists could not be updated (${error instanceof Error ? error.message : 'unknown error'}). The current lists stay in use.`);
      return false;
    }
  }

  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

// Where the bundled lists are: resources/filter-lists in the repository during development, the installed app's
// resources folder when packaged (electron-builder's extraResources). VESTIGIUM_FILTER_LISTS replaces them (tests
// use a small list that knows the demo site's ad host).
export function bundledListsDir(projectRoot: string, resourcesPath: string, packaged: boolean): string {
  if (process.env.VESTIGIUM_FILTER_LISTS) return process.env.VESTIGIUM_FILTER_LISTS;
  return packaged ? join(resourcesPath, 'filter-lists') : join(projectRoot, 'resources', 'filter-lists');
}
