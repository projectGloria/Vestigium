import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import electron from 'electron';

// Glob instead of a hand-maintained list so a new test file can never be silently skipped.
const sources = readdirSync('tests/app-unit').filter(name => name.endsWith('.test.ts')).sort().map(name => join('tests/app-unit', name));
if (sources.length === 0) throw new Error('No unit tests found in tests/app-unit.');
// Clear stale bundles so a deleted test file cannot keep running from .unit-build.
rmSync('.unit-build', { recursive: true, force: true });
await build({ entryPoints: sources, outdir: '.unit-build', bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['better-sqlite3', 'electron'] });
const bundles = sources.map(source => join('.unit-build', basename(source, '.ts') + '.cjs'));
// Match better-sqlite3's Electron ABI without rebuilding it back and forth for host Node.
const result = spawnSync(electron, ['--test', ...bundles], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
