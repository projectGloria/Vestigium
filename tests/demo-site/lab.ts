import { escapeHtml as esc, page } from './pages.js';

// Recorder lab: one page that exercises every capture surface milestone 2 needs
// (typing + Enter, select, sensitive field, open shadow DOM, same/cross-origin iframes, SPA routes, nested scroll).
export const LAB_VIEWS = ['one', 'two'] as const;
export type LabView = (typeof LAB_VIEWS)[number];

export interface LabOptions {
  query: string | null;
  view: LabView | null;
  origin: string;
  hostOrigin: string;
}

export function labPage({ query, view, hostOrigin }: LabOptions) {
  const results = query === null
    ? '<p id="search-status" role="status">No search yet.</p>'
    : `<p id="search-status" role="status">Results for "${esc(query)}"</p>`;
  const spa = view === null ? 'SPA view: home' : `SPA view: ${view}`;
  const body = `
    <form id="search" role="search" action="/lab" method="get">
      <label>Search notes <input name="q" value="${esc(query ?? '')}" autocomplete="off"></label>
    </form>
    ${results}
    <label>Tag
      <select id="tag" name="tag">
        <option value="">Any tag</option>
        <option value="landscape">Landscape</option>
        <option value="architecture">Architecture</option>
        <option value="portrait">Portrait</option>
      </select>
    </label>
    <p id="tag-status" role="status">Tag filter: any</p>
    <label>Archive password <input id="archive-password" type="password" autocomplete="off"></label>
    <h2>Shadow widget</h2>
    <lab-widget></lab-widget>
    <h2>Frames</h2>
    <iframe title="Same-origin frame" src="/lab/frame?label=Same-origin" width="420" height="160"></iframe>
    <iframe title="Cross-origin frame" src="${esc(hostOrigin)}/lab/frame?label=Cross-origin" width="420" height="160"></iframe>
    <h2>Single-page routes</h2>
    <nav aria-label="SPA routes">
      <a data-spa href="/lab/spa/one">View one</a>
      <a data-spa href="/lab/spa/two">View two</a>
    </nav>
    <p id="spa-status" role="status">${spa}</p>
    <h2>Scroll area</h2>
    <div id="scroll-box" role="region" aria-label="Scroll area" tabindex="0" style="height:180px;overflow:auto;border:1px solid #d6dbd0">
      <div style="height:1600px;position:relative">
        <button id="bottom-action" style="position:absolute;bottom:16px;left:16px">Bottom action</button>
      </div>
    </div>
    <p id="scroll-status" role="status">Bottom action not used</p>
    <h2>Trusted input</h2>
    <button id="trusted-action">Trusted action</button>
    <p id="trusted-status" role="status">Trusted action not used</p>`;
  // Inline script is fixture-only; it defines the shadow element and the SPA router without any library.
  const script = `
    customElements.define('lab-widget', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<div class="widget"><button id="shadow-action">Shadow action</button>'
          + ' <a href="/item/2">Shadow link</a><p id="shadow-status" role="status">Shadow clicked 0</p></div>';
        let count = 0;
        root.getElementById('shadow-action').addEventListener('click', () => {
          count++;
          root.getElementById('shadow-status').textContent = 'Shadow clicked ' + count;
        });
      }
    });
    document.getElementById('tag').addEventListener('change', event => {
      document.getElementById('tag-status').textContent = 'Tag filter: ' + (event.target.value || 'any');
    });
    // Reports whether the click came from real input (OS / CDP) or from a script (element.click()).
    document.getElementById('trusted-action').addEventListener('click', event => {
      document.getElementById('trusted-status').textContent = event.isTrusted ? 'Trusted click received' : 'Synthetic click received';
    });
    document.getElementById('bottom-action').addEventListener('click', () => {
      document.getElementById('scroll-status').textContent = 'Bottom action used';
    });
    const showView = path => {
      const match = /^\\/lab\\/spa\\/(one|two)$/.exec(path);
      document.getElementById('spa-status').textContent = 'SPA view: ' + (match ? match[1] : 'home');
    };
    for (const link of document.querySelectorAll('a[data-spa]')) {
      link.addEventListener('click', event => {
        event.preventDefault();
        history.pushState({}, '', link.getAttribute('href'));
        showView(location.pathname);
      });
    }
    addEventListener('popstate', () => showView(location.pathname));`;
  return page('Recorder lab', body, script);
}

// Minimal document without the cookie overlay: frames must stay interactive on their own.
export function labFrame(label: string, origin: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(label)} frame</title>
  <link rel="stylesheet" href="/assets/style.css"></head>
  <body style="padding:12px"><p>${esc(label)} frame</p>
  <button id="frame-action">Frame action</button>
  <a href="${esc(origin)}/item/3" target="_top">Frame item</a>
  <p id="frame-status" role="status">Frame clicked 0</p>
  <script>let count=0;document.getElementById('frame-action').addEventListener('click',()=>{count++;document.getElementById('frame-status').textContent='Frame clicked '+count;});</script>
  </body></html>`;
}
