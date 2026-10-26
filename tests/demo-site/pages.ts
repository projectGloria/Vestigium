import { ITEMS, PASSWORD } from './fixtures.js';
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Vestigium</title><link rel="stylesheet" href="/assets/style.css"></head>
  <body><header><a class="brand" href="/">V / VESTIGIUM</a><nav><a href="/list">Collection</a><a href="/item/47">Featured</a><a href="/">Scenarios</a></nav></header>
  <div class="shell"><main><p class="eyebrow">LOCAL WORKFLOW LAB / MILESTONE 0</p><h1>${escapeHtml(title)}</h1>${body}</main>
  <aside><h2>Popular posts</h2>${cards([43, 44, 45], 'cards', '')}</aside></div>
  <footer><span>Local fixtures. Real browser behavior.</span><a href="/list">Browse collection</a><a href="/item/46">Latest post</a></footer>
  <div id="cookies" role="dialog" aria-label="Cookie preferences" hidden><div><h2>A small cookie, a persistent session.</h2><p>This local demo stores your banner preference in this browser.</p><button id="accept">Accept cookies</button></div></div>
  <script>if(localStorage.getItem('cookies')!=='accepted')document.getElementById('cookies').hidden=false;document.getElementById('accept').onclick=()=>{localStorage.setItem('cookies','accepted');document.getElementById('cookies').hidden=true};${script}</script></body></html>`;
}
// `broken`: that item's link points to a page that does not exist (a per-item failure that must not stop a crawl).
// `dead`: that item's page exists, but its download link is dead (404), so the item has no download.
export function cards(ids: number[], layout: string, suffix: string, broken = 0, dead = 0) {
  return ids.map(id => {
    const item = ITEMS[id - 1] ?? { id, title: 'New arrival 48', tag: 'Landscape', author: 'Author 1', date: '2026-10-24' };
    const query = id === dead ? `${suffix ? `${suffix}&` : '?'}variant=dead` : suffix;
    const content = `<a href="/item/${id === broken ? 999 : id}${escapeHtml(query)}">${escapeHtml(item.title)}</a>`;
    return layout === 'table' ? `<tr data-item-id="${id}"><td>${String(id).padStart(2, '0')}</td><td>${content}</td><td>${item.tag}</td><td>${item.date}</td></tr>` :
      `<article class="card" data-item-id="${id}"><span class="number">${String(id).padStart(2, '0')}</span><p class="tag">${item.tag}</p><h3>${content}</h3><p>${item.author} · ${item.date}</p></article>`;
  }).join('');
}
// `style`: the same facts as a definition list (default), a table, or inline "Label: value" lines, so metadata
// extraction is tested against more than one page structure.
export function metadata(id: number, style = 'list') {
  const item = ITEMS[id - 1] ?? ITEMS[0];
  const pairs: [string, string][] = [['Author', item.author], ['Tags', item.tag], ['Date', item.date]];
  // The password label keeps its own punctuation ("Password:"), as on the original page.
  if (item.passwordLabel) pairs.push([item.passwordLabel, PASSWORD]);
  if (style === 'table') return `<table class="facts"><tbody>${pairs.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}</tbody></table>`;
  if (style === 'inline') return `<div class="facts">${pairs.map(([label, value]) => `<p><strong>${label.replace(/:$/, '')}:</strong> ${value}</p>`).join('')}</div>`;
  return `<dl>${pairs.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>`;
}
export const css = `:root{color-scheme:light;font-family:system-ui,sans-serif;color:#21382e;background:#f5f4ed}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-underline-offset:4px}button,.button{background:#204f3c;color:white;border:0;border-radius:6px;padding:12px 18px;font:inherit;cursor:pointer;display:inline-block}button:disabled{opacity:.45;cursor:default}header{padding:24px 5%;display:flex;justify-content:space-between;border-bottom:1px solid #d6dbd0;gap:24px}.brand{font-weight:800;text-decoration:none;letter-spacing:.12em}nav{display:flex;gap:24px}.shell{max-width:1500px;margin:auto;padding:48px 5%;display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:48px}h1{font-size:clamp(32px,4vw,58px);letter-spacing:-.05em;margin:10px 0 24px}h2{font-size:20px}h3{margin:12px 0;font-size:20px}.eyebrow,.tag{font-size:11px;letter-spacing:.14em;font-weight:700}.eyebrow{color:#597a64}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{border:1px solid #d6dbd0;border-radius:8px;background:#fffef9;padding:24px;margin-bottom:12px}.card p:last-child{color:#647568;font-size:12px}.number{color:#8b9d8e;font-size:28px;font-weight:300}aside{border-left:1px solid #d6dbd0;padding-left:24px}aside .card{padding:15px}aside h3{font-size:16px}aside .number{display:none}.pagination{display:flex;gap:14px;align-items:center;margin-top:28px;flex-wrap:wrap}footer{border-top:1px solid #d6dbd0;padding:24px 5%;display:flex;gap:24px;font-size:13px}footer span{margin-right:auto}#cookies:not([hidden]){position:fixed;inset:0;background:#13291c99;display:grid;place-items:center;z-index:100}#cookies>div{background:#fffef9;border-radius:12px;padding:32px;max-width:500px;margin:24px}table{border-collapse:collapse;width:100%;background:#fffef9}td,th{text-align:left;padding:18px 12px;border-bottom:1px solid #d6dbd0}dl{display:grid;grid-template-columns:160px 1fr;gap:16px;padding:24px;background:#fffef9}dd{margin:0}input{display:block;padding:12px;font:inherit;margin:8px 0 20px;max-width:100%}.scenarios{list-style:none;padding:0}.scenarios li{padding:14px 0;border-bottom:1px solid #d6dbd0}.status{padding:20px;background:#e5eddf;margin:20px 0}#sentinel{height:32px}@media(max-width:850px){.shell{grid-template-columns:1fr}aside{border-left:0;padding-left:0}.grid{grid-template-columns:1fr}header,footer{flex-wrap:wrap}table{font-size:12px}td,th{padding:12px 5px}}`;
