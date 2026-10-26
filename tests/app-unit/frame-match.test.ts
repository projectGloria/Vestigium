import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFrame } from '../../src/main/engine/frame-match.js';

const same = 'http://127.0.0.1:4173/lab/frame?label=Same-origin';
const cross = 'http://127.0.0.1:4174/lab/frame?label=Cross-origin';
const children = [{ url: same, name: '' }, { url: cross, name: '' }];

test('exact URL wins; recorded position breaks no tie by itself', () => {
  assert.equal(matchFrame(children, { url: same, name: '', index: 0 }), 0);
  assert.equal(matchFrame(children, { url: cross, name: '', index: 1 }), 1);
  // The recorded position is stale (an iframe was inserted before), but the URL still identifies the frame.
  assert.equal(matchFrame([{ url: 'https://ads.example/slot', name: '' }, ...children], { url: cross, name: '', index: 1 }), 2);
});

test('a changed query string (tokens) still matches by origin and path', () => {
  const refreshed = [{ url: 'http://127.0.0.1:4174/lab/frame?label=Cross-origin&token=new', name: '' }];
  assert.equal(matchFrame(refreshed, { url: `${cross}&token=old`, name: '', index: 0 }), 0);
});

test('a frame name identifies a frame whose URL changed completely', () => {
  const renamed = [{ url: 'about:blank', name: '' }, { url: 'https://cdn.example/v2/player', name: 'player' }];
  assert.equal(matchFrame(renamed, { url: 'https://cdn.example/v1/player.html', name: 'player', index: 1 }), 1);
});

test('position alone, unrelated frames and ambiguous duplicates give no match', () => {
  assert.equal(matchFrame([{ url: 'https://other.example/', name: '' }], { url: cross, name: '', index: 0 }), null);
  assert.equal(matchFrame([], { url: cross, name: '', index: 0 }), null);
  const twins = [{ url: cross, name: '' }, { url: cross, name: '' }, { url: cross, name: '' }];
  // Identical twins: the recorded position decides...
  assert.equal(matchFrame(twins, { url: cross, name: '', index: 2 }), 2);
  // ...but if that position no longer exists, guessing between equal candidates is refused.
  assert.equal(matchFrame(twins.slice(0, 2), { url: cross, name: '', index: 2 }), null);
  // Opaque origins (about:srcdoc, data:) only match by exact URL or name.
  assert.equal(matchFrame([{ url: 'about:srcdoc', name: '' }], { url: 'about:srcdoc', name: '', index: 0 }), 0);
  assert.equal(matchFrame([{ url: 'about:blank', name: '' }], { url: 'about:srcdoc', name: '', index: 0 }), null);
});
