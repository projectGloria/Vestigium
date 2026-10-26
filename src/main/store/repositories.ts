import type Database from 'better-sqlite3';
import type { DownloadJob, Item, RunRecord, Settings, SiteProfile, Versioned, Workflow } from '../../shared/types.js';
import { settingSchemas } from '../validation.js';
import { validateWorkflow } from '../engine/workflow-json.js';
import { validateDownloadJob, validateItem } from '../downloads/schema.js';
import { validateSiteProfile } from '../engine/site-profiles.js';
import { validateRunRecord } from '../engine/run-history.js';

type Table = 'workflows' | 'site_profiles' | 'items' | 'download_jobs' | 'run_log';
export class DocumentRepository<T extends Versioned & { id: string }> {
  // Entities with a runtime schema validate on every read and write, so the DB cannot hold or hand out malformed documents.
  constructor(private db: Database.Database, private table: Table, private validate: (value: unknown) => T = value => value as T) {}
  get(id: string): T | null { const row = this.db.prepare(`SELECT document FROM ${this.table} WHERE id=?`).get(id) as { document: string } | undefined; return row ? this.validate(JSON.parse(row.document)) : null; }
  list(): T[] { return (this.db.prepare(`SELECT document FROM ${this.table} ORDER BY id`).all() as { document: string }[]).map(row => this.validate(JSON.parse(row.document))); }
  save(input: T): void {
    if (!input.id || input.schemaVersion !== 1) throw new Error('Records require an ID and schemaVersion 1.');
    const value = this.validate(input);
    this.db.prepare(`INSERT INTO ${this.table} (id,schema_version,document) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`).run(value.id, JSON.stringify(value));
  }
  delete(id: string): boolean { return this.db.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id).changes > 0; }
  // IDs only, without parsing documents: lets callers load rows one by one and survive a single corrupted row.
  ids(): string[] { return (this.db.prepare(`SELECT id FROM ${this.table} ORDER BY id`).all() as { id: string }[]).map(row => row.id); }
}
export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark', lastUrl: 'about:blank', windowBounds: { width: 1280, height: 860 },
  // Human-like pacing by default; a few hundred milliseconds per step is negligible next to page loads.
  run: { stepDelayMinMs: 300, stepDelayMaxMs: 900, hostIntervalMs: 1000 },
  // Plan §4: three parallel file downloads by default.
  downloads: { directory: '', concurrency: 3, retries: 4, force: false, template: '{site}/{filename}', sidecar: true, extract: 'off' },
  // Plan §2's examples plus common translations of "password"; the user can change the list.
  metadata: {
    labels: ['Password', 'Pass', 'Unzip password', 'Archive password', 'Şifre', 'Parola', 'Contraseña', 'Mot de passe', 'Passwort', 'Kennwort',
      'Author', 'Artist', 'Model', 'Tags', 'Tag', 'Category', 'Date', 'Published', 'Version', 'License'],
  },
  safety: { allowlist: [], confirmRisky: true },
  tray: { minimizeToTray: false },
  // On by default: ad networks' popups and overlays get in the way of runs (they steal clicks and open tabs).
  adblock: { enabled: true },
};
export class SettingsRepository {
  constructor(private db: Database.Database) {}
  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.prepare('SELECT document FROM settings WHERE key=?').get(key) as { document: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
    const record = JSON.parse(row.document) as { schemaVersion: number; value: unknown };
    if (record.schemaVersion !== 1) throw new Error('Unsupported settings schema version.');
    return settingSchemas[key].parse(record.value) as Settings[K];
  }
  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const parsed = settingSchemas[key].parse(value);
    this.db.prepare('INSERT INTO settings VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document').run(key, JSON.stringify({ schemaVersion: 1, value: parsed }));
  }
  all(): Settings { return { theme: this.get('theme'), lastUrl: this.get('lastUrl'), windowBounds: this.get('windowBounds'), run: this.get('run'), downloads: this.get('downloads'), metadata: this.get('metadata'),
    safety: this.get('safety'), tray: this.get('tray'), adblock: this.get('adblock') }; }
  delete(key: keyof Settings): boolean { return this.db.prepare('DELETE FROM settings WHERE key=?').run(key).changes > 0; }
}
export function repositories(db: Database.Database) {
  return {
    workflows: new DocumentRepository<Workflow>(db, 'workflows', validateWorkflow), siteProfiles: new DocumentRepository<SiteProfile>(db, 'site_profiles', validateSiteProfile),
    items: new DocumentRepository<Item>(db, 'items', validateItem), downloads: new DocumentRepository<DownloadJob>(db, 'download_jobs', validateDownloadJob),
    // run_log holds finished runs (milestone 8); the application log itself stays in rotating files.
    runLog: new DocumentRepository<RunRecord>(db, 'run_log', validateRunRecord), settings: new SettingsRepository(db),
  };
}
