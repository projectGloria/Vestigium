import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { openDatabase, migrate } from '../../src/main/store/db.js';
import { repositories } from '../../src/main/store/repositories.js';
import { Logger } from '../../src/main/logger.js';
import type { Workflow, SiteProfile, Item, DownloadJob, RunRecord } from '../../src/shared/types.js';

function fixture() { const directory = mkdtempSync(join(tmpdir(), 'vestigium-unit-')); const db = openDatabase(join(directory, 'store.sqlite')); return { directory, db, repo: repositories(db), close() {
  db.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vestigium-unit-')) throw new Error('Refusing cleanup outside the temporary test database.');
  rmSync(directory, { recursive: true, force: true });
} }; }
test('empty database gets all tables, version history and WAL; migration is idempotent', () => {
  const f = fixture();
  try {
    assert.equal(f.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(f.db.pragma('synchronous', { simple: true }), 2);
    assert.deepEqual((f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name), ['download_jobs', 'items', 'run_log', 'schema_migrations', 'settings', 'site_profiles', 'workflows']);
    f.repo.settings.set('theme', 'light'); migrate(f.db); migrate(f.db);
    assert.equal(f.repo.settings.get('theme'), 'light');
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 2);
  } finally { f.close(); }
});
test('newer schema is rejected instead of silently downgrading', () => {
  const f = fixture(); try { f.db.prepare('INSERT INTO schema_migrations VALUES (99, ?)').run(new Date().toISOString()); assert.throws(() => migrate(f.db), /newer/); } finally { f.close(); }
});
test('typed repositories create, read, update, list and delete every entity', () => {
  const f = fixture();
  try {
    const workflow: Workflow = { schemaVersion: 1, id: 'workflow', name: 'Sample', siteProfileId: null, steps: [], variables: {}, createdAt: '2026-10-23T00:00:00Z', version: 1 };
    const profile: SiteProfile = { schemaVersion: 1, id: 'profile', domain: 'example.test', listPattern: null, itemPattern: null, paginationPattern: null, downloadPattern: null, metadataPatterns: {}, rateLimit: 1, lastVerifiedAt: null, health: 'ok' };
    const item: Item = { schemaVersion: 1, id: 'item', url: 'http://example.test/1', title: 'Note', sourcePage: 'http://example.test', metadata: {}, status: 'pending' };
    const download: DownloadJob = { schemaVersion: 1, id: 'download', itemId: 'item', url: 'http://example.test/file', filename: 'test.zip', tempPath: 'test.part', finalPath: 'test.zip', totalBytes: null, receivedBytes: 0, status: 'queued', attempts: 0, error: null,
      title: 'Note', sourcePage: 'http://example.test/1', mimeType: null, etag: null, lastModified: null, sha256: null, duplicateOf: null, origin: null, createdAt: '2026-10-23T00:00:00.000Z', finishedAt: null };
    const run: RunRecord = { schemaVersion: 1, id: 'run', workflowId: 'workflow', workflowName: 'Sample', mode: 'run', status: 'done', startedAt: '2026-10-23T00:00:00.000Z',
      finishedAt: '2026-10-23T00:01:00.000Z', error: null, done: 3, failed: 0, skipped: 0, failure: null, failures: [] };
    function check<T extends { id: string; schemaVersion: 1 }>(repo: { save(value: T): void; get(id: string): T | null; list(): T[]; delete(id: string): boolean }, original: T, updated: T) {
      assert.equal(repo.get(original.id), null); repo.save(original); assert.deepEqual(repo.get(original.id), original);
      repo.save(updated); assert.deepEqual(repo.list(), [updated]); assert.equal(repo.delete(original.id), true); assert.equal(repo.delete(original.id), false); assert.deepEqual(repo.list(), []);
    }
    check(f.repo.workflows, workflow, { ...workflow, name: "Renamed ' workflow" });
    check(f.repo.siteProfiles, profile, { ...profile, health: 'degraded' });
    check(f.repo.items, item, { ...item, title: 'Unicode 雪' });
    check(f.repo.downloads, download, { ...download, status: 'paused' });
    check(f.repo.runLog, run, { ...run, status: 'failed', failed: 1 });
    assert.throws(() => f.repo.items.save({ ...item, schemaVersion: 2 as 1 }), /schemaVersion/);
  } finally { f.close(); }
});
test('settings validate, persist across reopen, and delete back to defaults', () => {
  const f = fixture();
  try {
    assert.equal(f.repo.settings.get('theme'), 'dark'); f.repo.settings.set('theme', 'light');
    f.repo.settings.set('lastUrl', 'http://localhost:4173/list'); f.repo.settings.set('windowBounds', { x: -10, y: 30, width: 1100, height: 720 });
    const second = openDatabase(join(f.directory, 'store.sqlite'));
    try { assert.deepEqual(repositories(second).settings.all(), f.repo.settings.all()); } finally { second.close(); }
    assert.throws(() => f.repo.settings.set('lastUrl', 'javascript:alert(1)'));
    assert.equal(f.repo.settings.delete('theme'), true); assert.equal(f.repo.settings.get('theme'), 'dark');
  } finally { f.close(); }
});
test('application log rotates and exposes only the latest 200 entries', () => {
  const f = fixture();
  try {
    const log = new Logger(join(f.directory, 'logs'), 200); let notifications = 0; log.onChange = () => notifications++;
    for (let i = 0; i < 210; i++) log.write('info', `Entry ${i}`);
    assert.equal(log.recent().length, 200); assert.equal(notifications, 210);
    assert.deepEqual(readdirSync(join(f.directory, 'logs')).sort(), ['app.log', 'app.log.1', 'app.log.2', 'app.log.3']);
    assert.match(readFileSync(join(f.directory, 'logs', 'app.log'), 'utf8'), /Entry 209/);
    assert.equal(new Logger(join(f.directory, 'logs')).recent().at(-1)?.message, 'Entry 209');
  } finally { f.close(); }
});
