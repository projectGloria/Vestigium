// Refreshes the filter lists that ship with the app (resources/filter-lists). The app starts from these when it has
// no newer cached copy, so ad blocking works on the first start and offline. Run deliberately, then commit the result:
//   npm run filter-lists
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILTER_LISTS } from '../src/main/browser/filter-lists.js';

const target = join(import.meta.dirname, '..', 'resources', 'filter-lists');
// Download every list before touching the shipped copy: one failed or empty fetch must leave the tracked folder as it was,
// not half-deleted (a partial folder would ship an app without some of its blocking).
const downloaded: { id: string; text: string }[] = [];
for (const list of FILTER_LISTS) {
  const response = await fetch(list.url);
  if (!response.ok) throw new Error(`${list.url}: HTTP ${response.status}. Nothing in resources/filter-lists was changed.`);
  const text = await response.text();
  if (text.trim() === '') throw new Error(`${list.url}: empty response. Nothing in resources/filter-lists was changed.`);
  downloaded.push({ id: list.id, text });
  console.log(`${list.id}: ${text.split('\n').length} lines`);
}
await mkdir(target, { recursive: true });
// Lists dropped from FILTER_LISTS must not linger, so clear old .txt files, but only once every replacement is in hand.
for (const name of await readdir(target)) if (name.endsWith('.txt')) await rm(join(target, name));
for (const { id, text } of downloaded) await writeFile(join(target, `${id}.txt`), text);
await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), lists: FILTER_LISTS.map(list => list.id) }, null, 2)}\n`);
