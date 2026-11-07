import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import electron from 'electron';

// Optional filters, so one file or one test can run without a hand-copied esbuild command:
//   npm run test:unit -- store                          (files whose name contains "store")
//   npm run test:unit -- store --test-name-pattern="x"  (anything starting with "-" goes straight to node:test)
// Flags must carry their value after "=": a separate value would be indistinguishable from a file filter.
const args = process.argv.slice(2);
const fileFilters = args.filter(arg => !arg.startsWith('-'));
const testFlags = args.filter(arg => arg.startsWith('-'));

// Glob instead of a hand-maintained list so a new test file can never be silently skipped.
const all = readdirSync('tests/app-unit').filter(name => name.endsWith('.test.ts')).sort();
if (all.length === 0) throw new Error('No unit tests found in tests/app-unit.');
const sources = all.filter(name => fileFilters.length === 0 || fileFilters.some(filter => name.includes(filter))).map(name => join('tests/app-unit', name));
if (sources.length === 0) throw new Error(`No unit test file in tests/app-unit matches: ${fileFilters.join(', ')}.`);
// Clear stale bundles so a deleted test file cannot keep running from .unit-build.
rmSync('.unit-build', { recursive: true, force: true });
await build({ entryPoints: sources, outdir: '.unit-build', bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['better-sqlite3', 'electron'] });
const bundles = sources.map(source => join('.unit-build', basename(source, '.ts') + '.cjs'));
// Match better-sqlite3's Electron ABI without rebuilding it back and forth for host Node. The variable is set only on the
// child's env, so an interrupted run can never leave the caller's shell starting Electron as plain Node.
const result = spawnSync(electron, ['--test', ...testFlags, ...bundles], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
