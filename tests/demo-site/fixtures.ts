export const ITEMS = Array.from({ length: 47 }, (_, index) => ({
  id: index + 1, title: `Field Notes ${String(index + 1).padStart(2, '0')}`,
  author: `Author ${(index % 4) + 1}`, tag: ['Landscape', 'Architecture', 'Portrait'][index % 3],
  date: `2026-10-${String((index % 23) + 1).padStart(2, '0')}`,
  passwordLabel: ['Password:', 'Pass:', 'Unzip password:', 'Şifre:', null][index % 5],
}));
export const BASE_IDS = ITEMS.map(item => item.id);
// After the first request: remove 11, move 20 to the front and insert new item 48.
export const CHANGED_IDS = [20, ...BASE_IDS.filter(id => id !== 11 && id !== 20), 48];
export const CHANGING_CRAWL_IDS = [...BASE_IDS.slice(0, 10), ...CHANGED_IDS.slice(10)];
export const DUPLICATE_IDS = [...BASE_IDS.slice(0, 10), 9, 10, ...BASE_IDS.slice(10)];
export const PASSWORD = 'vestigium-demo';
export const ZIP_TEXT = 'Vestigium local download fixture.\n';
export const FILENAMES = {
  disposition: 'field-notes.zip', unicode: 'İstanbul-雪-مرحبا.zip',
  long: `${'Long title '.repeat(32)}.zip`, invalid: 'CON<notes>:"draft"|?*.zip',
};
export const SCENARIOS: [string, string][] = [
  ['Card pagination', '/list'], ['Table pagination', '/list?layout=table'],
  ['Infinite scroll', '/list?mode=infinite'], ['Load more', '/list?mode=more'],
  ['SPA pagination (URL unchanged)', '/list?mode=spa'], ['Pagination that wraps to page 1', '/list?wrap=1'],
  ['Single page', '/list?dataset=single'], ['Empty list', '/list?dataset=empty'],
  ['Duplicates', '/list?dataset=duplicates'], ['Changing list', '/list?dataset=changing'],
  ['ZIP download', '/item/1'], ['Countdown host', '/item/1?variant=countdown'],
  ['Popup download', '/item/1?variant=popup'], ['Short link with captcha', '/item/1?variant=shortlink'], ['Dead link', '/item/1?variant=dead'],
  ['HTML error', '/item/1?variant=html'], ['Expiring link', '/item/1?variant=expiring'],
  ['Large / Range enabled', '/item/1?variant=large'],
  ['Large / Range disabled', '/item/1?variant=large&range=off'],
  ['Filename in URL', '/item/1?variant=url'], ['No filename', '/item/1?variant=none'],
  ...Object.keys(FILENAMES).map(key => [`Filename: ${key}`, `/item/1?variant=${key}`] as [string, string]),
  ...['classes', 'move', 'wrap', 'reorder', 'all', 'label'].map(mode => [`DOM mutation: ${mode}`, `/item/1?mutate=${mode}`] as [string, string]),
  ['Login required', '/list?login=1'], ['Recorder lab', '/lab'], ['Ads and popunders', '/ads'],
  ...[2, 3, 4, 5].map(id => [`Metadata variant ${id}`, `/item/${id}`] as [string, string]),
];
