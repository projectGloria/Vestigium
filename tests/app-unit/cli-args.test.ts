import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCli } from '../../src/main/cli/args.js';

// Milestone 9: the command line of plan §8.

test('no command opens the app; run/profiles/help are commands', () => {
  assert.equal(parseCli([]), null);
  assert.equal(parseCli(['--some-chromium-switch']), null);
  assert.deepEqual(parseCli(['--help']), { kind: 'help' });
  assert.deepEqual(parseCli(['profiles']), { kind: 'profiles' });
  assert.deepEqual(parseCli(['--', 'profiles']), { kind: 'profiles' });
  assert.equal(parseCli(['--']), null);
  assert.deepEqual(parseCli(['profiles', 'x']), { kind: 'error', message: '"profiles" takes no options (got x).' });
});

test('run takes the plan\'s options; the site may be given as an address', () => {
  assert.deepEqual(parseCli(['run', '--profile', 'https://Example.com/list?page=2', '--url', 'https://example.com/list', '--output', 'D:\\files',
    '--max-pages', '3', '--max-items', '25', '--force', '--dry-run']), {
    kind: 'run', profile: 'example.com', url: 'https://example.com/list', output: 'D:\\files', maxPages: 3, maxItems: 25, force: true, dryRun: true,
  });
  assert.deepEqual(parseCli(['run', '--profile', '127.0.0.1:4173']), {
    kind: 'run', profile: '127.0.0.1:4173', url: null, output: null, maxPages: null, maxItems: null, force: false, dryRun: false,
  });
});

test('mistakes are explained, never guessed', () => {
  const error = (args: string[]) => {
    const result = parseCli(args);
    return result?.kind === 'error' ? result.message : null;
  };
  assert.equal(error(['run']), 'run needs --profile <site>. See vestigium profiles for the saved ones.');
  assert.equal(error(['run', '--profile']), '--profile needs a value.');
  assert.equal(error(['run', '--profile', '--force']), '--profile needs a value.');
  assert.equal(error(['run', '--profile', 'a.com', '--max-pages', '0']), '--max-pages needs a whole number from 1 to 100000.');
  assert.equal(error(['run', '--profile', 'a.com', '--max-items', 'lots']), '--max-items needs a whole number from 1 to 100000.');
  assert.equal(error(['run', '--profile', 'a.com', '--url', 'ftp://a.com/x']), '--url must start with http:// or https://.');
  assert.equal(error(['run', '--profile', 'a.com', '--verbose']), 'Unknown option --verbose. See vestigium --help.');
});
