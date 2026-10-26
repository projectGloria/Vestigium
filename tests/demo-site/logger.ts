import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
export function createLogger(directory: string, maxBytes = 1_048_576) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'demo.log');
  return (level: 'info' | 'warn' | 'error', message: string, details = {}) => {
    if (existsSync(file) && statSync(file).size >= maxBytes) {
      rmSync(`${file}.3`, { force: true });
      for (let i = 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), level, message, ...details }) + '\n');
  };
}
