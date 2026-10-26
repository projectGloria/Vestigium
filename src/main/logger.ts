import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LogEntry, LogLevel } from '../shared/types.js';
export class Logger {
  private file: string;
  private entries: LogEntry[] = [];
  onChange?: () => void;
  // Every entry as it is written (the command line prints them).
  onWrite?: (entry: LogEntry) => void;
  constructor(directory: string, private maxBytes = 1024 * 1024) {
    mkdirSync(directory, { recursive: true }); this.file = join(directory, 'app.log');
    if (existsSync(this.file)) for (const line of readFileSync(this.file, 'utf8').trim().split('\n').slice(-200)) {
      try { this.entries.push(JSON.parse(line) as LogEntry); } catch { /* Ignore a truncated final log line after a crash. */ }
    }
  }
  recent(): LogEntry[] { return [...this.entries]; }
  write(level: LogLevel, message: string) {
    const entry: LogEntry = { schemaVersion: 1, id: randomUUID(), time: new Date().toISOString(), level, message };
    if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) {
      rmSync(`${this.file}.3`, { force: true });
      for (let i = 2; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      renameSync(this.file, `${this.file}.1`);
    }
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.entries.push(entry); this.entries = this.entries.slice(-200); this.onWrite?.(entry); this.onChange?.();
  }
}
