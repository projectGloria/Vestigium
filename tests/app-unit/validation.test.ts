import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, isBrowserUrl } from '../../src/main/validation.js';
test('navigation accepts only http(s) and a blank tab, without credentials', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:4173/list?q=hello', 'about:blank']) assert.equal(isBrowserUrl(url), true);
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hello', 'mailto:user@example.com', 'https://user:pass@example.com', 'not a url', 'about:config']) assert.throws(() => validatePayload('navigate', { url }));
});
test('all command payloads reject wrong shapes, unknown keys and unsafe IDs', () => {
  assert.deepEqual(validatePayload('navigate', { url: 'https://example.com' }), { url: 'https://example.com' });
  for (const payload of [null, [], { url: 1 }, { url: 'https://example.com', extra: true }, { url: 'x'.repeat(8193) }]) assert.throws(() => validatePayload('navigate', payload));
  for (const command of ['state', 'back', 'forward', 'reload', 'newTab'] as const) { assert.equal(validatePayload(command, undefined), undefined); assert.throws(() => validatePayload(command, {})); }
  for (const command of ['selectTab', 'closeTab'] as const) {
    assert.deepEqual(validatePayload(command, { id: 1 }), { id: 1 });
    for (const id of [0, -1, 1.5, '1', NaN, Infinity]) assert.throws(() => validatePayload(command, { id }));
    assert.throws(() => validatePayload(command, { id: 1, other: true }));
  }
  assert.deepEqual(validatePayload('theme', { theme: 'light' }), { theme: 'light' });
  assert.throws(() => validatePayload('theme', { theme: 'system' }));
});
