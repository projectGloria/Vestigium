// The subscriptions the ad blocker uses: Ghostery's mirror of EasyList, Peter Lowe's list and uBlock Origin's lists
// (the library's "ads and tracking" set). Shared by the app (weekly refresh) and scripts/update-filter-lists.ts
// (the copy bundled in resources/filter-lists). No annoyance or cookie-notice lists: those hide page content,
// which would change what the recorder sees.
const MIRROR = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const lists = [
  'easylist/easylist', 'easylist/easyprivacy', 'peter-lowe/serverlist',
  'ublock-origin/badware', 'ublock-origin/filters', 'ublock-origin/filters-2020', 'ublock-origin/filters-2021',
  'ublock-origin/filters-2022', 'ublock-origin/filters-2023', 'ublock-origin/filters-2024', 'ublock-origin/privacy',
  'ublock-origin/quick-fixes', 'ublock-origin/resource-abuse', 'ublock-origin/unbreak',
];
export const FILTER_LISTS = lists.map(path => ({ id: path.replace('/', '-'), url: `${MIRROR}/${path}.txt` }));
