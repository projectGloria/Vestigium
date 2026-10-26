// Refreshes the filter lists that ship with the app (resources/filter-lists). The app starts from these when it has
// no newer cached copy, so ad blocking works on the first start and offline. Run deliberately, then commit the result:
//   npm run filter-lists
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILTER_LISTS } from '../src/main/browser/filter-lists.js';

const target = join(import.meta.dirname, '..', 'resources', 'filter-lists');
await mkdir(target, { recursive: true });
for (const name of await readdir(target)) if (name.endsWith('.txt')) await rm(join(target, name));
for (const list of FILTER_LISTS) {
  const response = await fetch(list.url);
  if (!response.ok) throw new Error(`${list.url}: HTTP ${response.status}`);
  const text = await response.text();
  await writeFile(join(target, `${list.id}.txt`), text);
  console.log(`${list.id}: ${text.split('\n').length} lines`);
}
await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), lists: FILTER_LISTS.map(list => list.id) }, null, 2)}\n`);
