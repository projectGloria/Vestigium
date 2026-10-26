import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initialSchema } from './migrations/001-initial.js';
import { downloadIndexes } from './migrations/002-download-index.js';

export function migrate(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrations = [{ version: 1, sql: initialSchema }, { version: 2, sql: downloadIndexes }];
  const latest = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  if (latest.version > migrations.length) throw new Error('Database was created by a newer Vestigium version.');
  for (const migration of migrations) db.transaction(() => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) return;
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, new Date().toISOString());
  })();
}
export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try { db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON'); migrate(db); return db; }
  catch (error) { db.close(); throw error; }
}
