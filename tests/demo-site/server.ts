import express from 'express';
import type { Express, Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { BASE_IDS, CHANGED_IDS, DUPLICATE_IDS, ITEMS, SCENARIOS } from './fixtures.js';
import { cards, css, escapeHtml as esc, metadata, page } from './pages.js';
import { makeZip, sendDownload } from './downloads.js';
import { createLogger } from './logger.js';
import { LAB_VIEWS, labFrame, labPage, type LabView } from './lab.js';

export interface DemoOptions {
  port?: number; hostPort?: number; seed?: number; logDirectory?: string;
  largeBytes?: number; throttleBytesPerSecond?: number; rangeEnabled?: boolean;
  tokenLifetimeMs?: number; sessionRequests?: number; loginRequired?: boolean;
}
export interface DemoServer { origin: string; hostOrigin: string; close(): Promise<void> }
async function listen(app: Express, port: number) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Demo server did not bind a TCP port.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
export async function createDemoServer(options: DemoOptions = {}): Promise<DemoServer> {
  const config = { port: 4173, hostPort: 4174, seed: 1, largeBytes: 64 * 1024 * 1024,
    throttleBytesPerSecond: 0, rangeEnabled: true, tokenLifetimeMs: 5000, sessionRequests: 5,
    loginRequired: false, ...options };
  for (const key of ['largeBytes', 'tokenLifetimeMs', 'sessionRequests'] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer.`);
  if (!Number.isFinite(config.throttleBytesPerSecond) || config.throttleBytesPerSecond < 0) throw new Error('throttleBytesPerSecond must be nonnegative.');
  const log = createLogger(options.logDirectory ?? join('.demo-logs', randomUUID()));
  const zip = await makeZip();
  const sessions = new Map<string, number>();
  const tokens = new Map<string, number>();
  const countdowns = new Map<string, number>();
  let changingRequests = 0, mutationRequests = 0;
  let origin = '', hostOrigin = '';
  const app = express(), host = express();
  const cookieName = `vestigium_${randomUUID().replaceAll('-', '')}`;
  const protectedRequest = (req: Request) => config.loginRequired || req.query.login === '1';
  function safeReturn(value: unknown) {
    const path = typeof value === 'string' ? value : '/list?login=1';
    return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/list?login=1';
  }
  for (const current of [app, host]) {
    current.disable('x-powered-by');
    current.use(express.urlencoded({ extended: false }));
    current.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      res.on('finish', () => log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        res.statusCode >= 400 ? `Request failed: ${res.statusMessage}` : 'Request completed', { method: req.method, path: req.path, status: res.statusCode }));
      next();
    });
    current.get('/health', (_req, res) => res.json({ status: 'ok' }));
    current.get('/assets/style.css', (_req, res) => res.type('css').send(css));
    current.get('/favicon.ico', (_req, res) => res.status(204).end());
    current.get('/login', (req, res) => res.send(page('Demo login', `<p>Fictional credentials: <strong>demo / vestigium</strong></p>
      <form method="post" action="/login"><input type="hidden" name="returnTo" value="${esc(safeReturn(req.query.returnTo))}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`)));
    current.post('/login', (req, res) => {
      if (req.body.username !== 'demo' || req.body.password !== 'vestigium') { res.status(401).send(page('Login failed', '<p>Incorrect demo credentials.</p><a href="javascript:history.back()">Try again</a>')); return; }
      const previous = req.headers.cookie?.split('; ').find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (previous) sessions.delete(previous);
      const session = randomUUID(); sessions.set(session, 0);
      res.cookie(cookieName, session, { httpOnly: true, sameSite: 'lax', path: '/' });
      res.redirect(303, safeReturn(req.body.returnTo));
    });
    current.use((req, res, next) => {
      if (!protectedRequest(req)) { next(); return; }
      const cookie = req.headers.cookie?.split('; ').find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const count = cookie ? sessions.get(cookie) : undefined;
      if (count === undefined || count >= config.sessionRequests) {
        if (cookie) sessions.delete(cookie);
        res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`); return;
      }
      sessions.set(cookie!, count + 1); next();
    });
    current.get(['/files/:kind', '/files/:kind/:name'], async (req, res) => {
      if (req.params.kind === 'expiring') {
        const expiry = tokens.get(String(req.query.token));
        if (!expiry || expiry <= Date.now()) { res.status(410).type('text').send('Download link expired. Reload the item page to renew it.'); return; }
      }
      if (req.params.kind === 'countdown') {
        const readyAt = countdowns.get(String(req.query.ticket));
        if (!readyAt) { res.status(403).send('Open the countdown page before downloading.'); return; }
        if (Date.now() < readyAt) { res.status(425).send('Countdown is still running. Wait, then press Continue.'); return; }
      }
      await sendDownload(req, res, { zip, ...config });
    });
    current.get('/lab/frame', (req, res) => {
      const label = req.query.label === 'Cross-origin' ? 'Cross-origin' : 'Same-origin';
      res.send(labFrame(label, origin));
    });
  }
  app.get('/', (_req, res) => res.send(page('A place to teach the browser.', `<p>47 field notes. Deliberately imperfect pages. A local test bench for learning a workflow from one demonstration.</p><h2>Choose a scenario</h2><ul class="scenarios">${SCENARIOS.map(([label, url]) => `<li><a href="${esc(url)}">${esc(label)}</a></li>`).join('')}</ul>`)));
  app.get('/list', (req, res) => {
    const mode = String(req.query.mode ?? 'pages'), layout = req.query.layout === 'table' ? 'table' : 'cards';
    const dataset = String(req.query.dataset ?? 'normal');
    let ids = dataset === 'empty' ? [] : dataset === 'single' ? BASE_IDS.slice(0, 7) : dataset === 'duplicates' ? DUPLICATE_IDS : BASE_IDS;
    if (dataset === 'changing') ids = changingRequests++ === 0 ? BASE_IDS : CHANGED_IDS;
    const number = Number(req.query.page ?? 1);
    if (!Number.isInteger(number) || number < 1) { res.status(400).send('Page must be a positive integer.'); return; }
    const selected = ids.slice((number - 1) * 10, number * 10), more = number * 10 < ids.length;
    // `variant`: every item's download uses that variant (e.g. variant=aes: password-protected archives).
    const itemQuery = new URLSearchParams();
    if (protectedRequest(req)) itemQuery.set('login', '1');
    if (typeof req.query.variant === 'string' && /^[a-z]+$/.test(req.query.variant)) itemQuery.set('variant', req.query.variant);
    const suffix = itemQuery.size ? `?${itemQuery}` : '';
    const markup = cards(selected, layout, suffix, Number(req.query.broken ?? 0) || 0, Number(req.query.dead ?? 0) || 0);
    if (req.query.fragment === '1') { res.json({ html: markup, more, total: ids.length }); return; }
    const params = new URLSearchParams(req.query as Record<string, string>);
    params.delete('fragment');
    const link = (n: number) => { const p = new URLSearchParams(params); p.set('page', String(n)); return `/list?${p}`; };
    const listing = layout === 'table' ? `<table><thead><tr><th>No.</th><th>Title</th><th>Tags</th><th>Date</th></tr></thead><tbody id="items">${markup}</tbody></table>` : `<section id="items" class="grid" aria-label="Collection items">${markup}</section>`;
    // wrap=1: the last page's Next link points back to page 1 (a crawler must notice the repeated content).
    const wrap = req.query.wrap === '1';
    const pages = Math.max(1, Math.ceil(ids.length / 10));
    const nextLink = more ? `<a rel="next" href="${esc(link(number + 1))}">Next →</a>` : wrap ? `<a rel="next" href="${esc(link(1))}">Next →</a>` : '<button disabled>Next →</button>';
    const numbered = Array.from({ length: pages }, (_, i) => `<a ${i + 1 === number ? 'aria-current="page"' : ''} href="${esc(link(i + 1))}">${i + 1}</a>`).join('');
    // mode=spa: a Next button swaps the items in place via fetch; the URL never changes.
    const pagination = mode === 'pages' ? `<nav class="pagination" aria-label="Pagination">${numbered}${nextLink}</nav>`
      : mode === 'spa' ? `<nav class="pagination" aria-label="Pagination"><span id="page-label">Page ${number} of ${pages}</span><button id="spa-next" ${more ? '' : 'disabled'}>Next ›</button></nav>`
      : `<button id="more" ${more ? '' : 'disabled'}>Load more</button><div id="sentinel"></div>`;
    const spaScript = `let current=${number};const next=document.getElementById('spa-next');next.onclick=async()=>{next.disabled=true;const url=new URL(location.href);url.searchParams.set('page',String(current+1));url.searchParams.set('fragment','1');const response=await fetch(url);const data=await response.json();document.getElementById('items').innerHTML=data.html;current++;document.getElementById('page-label').textContent='Page '+current+' of ${pages}';document.getElementById('status').textContent=data.more?'More items available':'End of collection';next.disabled=!data.more;};`;
    const script = mode === 'pages' ? '' : mode === 'spa' ? spaScript : `let next=${number + 1},busy=false,hasMore=${more};const button=document.getElementById('more');async function load(){if(busy||!hasMore)return;busy=true;button.disabled=true;try{const url=new URL(location.href);url.searchParams.set('page',String(next));url.searchParams.set('fragment','1');const response=await fetch(url);if(!response.ok||response.redirected)throw Error('List could not load. Sign in or reload to continue.');const data=await response.json();document.getElementById('items').insertAdjacentHTML('beforeend',data.html);hasMore=data.more;next++;document.getElementById('status').textContent=hasMore?'More items available':'End of collection';}catch(error){document.getElementById('status').textContent=error.message;}finally{busy=false;button.disabled=!hasMore;}}button.onclick=load;${mode === 'infinite' ? `button.style.display='none';addEventListener('scroll',()=>{if(document.getElementById('sentinel').getBoundingClientRect().top<innerHeight+100)void load()});` : ''}`;
    res.send(page('The field notes collection', `<p>${ids.length} entries · ${layout === 'table' ? 'Table' : 'Cards'} · ${esc(mode)}</p>${listing}<p id="status" role="status">${ids.length === 0 ? 'No items found' : more ? 'More items available' : 'End of collection'}</p>${pagination}`, script));
  });
  app.get('/item/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 48) { res.status(404).send('Item does not exist.'); return; }
    const variant = String(req.query.variant ?? 'disposition');
    const query = new URLSearchParams();
    if (protectedRequest(req)) query.set('login', '1');
    for (const key of ['range', 'throttle']) if (req.query[key]) query.set(key, String(req.query[key]));
    if (variant === 'expiring') {
      for (const [token, expiry] of tokens) if (expiry <= Date.now()) tokens.delete(token);
      const token = randomUUID(); tokens.set(token, Date.now() + config.tokenLifetimeMs); query.set('token', token);
    }
    let href = `/files/${variant}${variant === 'url' ? '/url-only.zip' : ''}?${query}`;
    if (variant === 'countdown') href = `${hostOrigin}/countdown?${query}`;
    if (variant === 'popup') href = `${hostOrigin}/popup?${query}`;
    if (variant === 'captcha') href = `${hostOrigin}/captcha?${query}`;
    if (variant === 'shortlink') href = `${hostOrigin}/shortlink?${query}`;
    const mutation = String(req.query.mutate ?? 'none');
    const has = (name: string) => mutation === name || mutation === 'all';
    const random = createHash('sha256').update(`${config.seed}:${mutationRequests++}`).digest('hex');
    const className = has('classes') ? `action-${random.slice(0, 10)}` : 'download-action';
    // mutate=label renames the button slightly (fuzzy self-healing test); it is deliberately not part of mutate=all.
    const caption = mutation === 'label' ? 'Download ZIP file' : 'Download ZIP';
    let button = `<a class="${className}" href="${esc(href)}" ${variant === 'popup' || variant === 'shortlink' ? 'target="_blank" rel="noopener"' : ''}>${caption}${variant === 'large' ? ' / generated file' : ''}</a>`;
    if (has('wrap')) button = `<div><section><div>${button}</div></section></div>`;
    const description = '<p class="description">A downloadable field note with metadata for your collection.</p>';
    const facts = metadata(id, String(req.query.meta ?? 'list'));
    const info = has('reorder') ? facts + description : description + facts;
    const body = has('move') ? `<section class="moved-action">${button}</section>${info}` : `${info}<section class="original-action">${button}</section>`;
    res.send(page(ITEMS[id - 1]?.title ?? 'New arrival 48', body));
  });
  // A button that reads like deleting something: a run must stop and ask before clicking it (plan §7).
  app.get('/confirm', (_req, res) => res.send(page('Manage your notes', `<p>Nothing here is really deleted.</p><button id="delete">Delete this note</button><p id="result" role="status"></p>`,
    `document.getElementById('delete').addEventListener('click',()=>{document.getElementById('result').textContent='Deleted (demo only).'});`)));
  app.get(['/lab', '/lab/spa/:view'], (req, res) => {
    const view = req.params.view as string | undefined;
    if (view !== undefined && !LAB_VIEWS.includes(view as LabView)) { res.status(404).send('This lab view does not exist.'); return; }
    const query = typeof req.query.q === 'string' ? req.query.q : null;
    res.send(labPage({ query, view: (view ?? null) as LabView | null, origin, hostOrigin }));
  });
  // An ad-supported page. The "ad network" lives on the second origin under /demo-ads/ (the test filter list,
  // tests/demo-site/filter-lists, blocks that path): a banner script that inserts an ad and opens a popunder on the
  // first click anywhere, like the networks on real download sites. The sponsor button opens an ad page itself
  // (an inline script, not blocked), so the popup guard is tested on its own.
  app.get('/ads', (_req, res) => res.send(page('Sponsored download', `<p id="content">The file below is free. Ads pay for the hosting.</p>
    <p><a id="download" class="button" href="/files/disposition">Download ZIP</a> <button id="sponsor">Visit our sponsor</button></p>
    <script src="${hostOrigin}/demo-ads/banner.js"></script>`,
    `document.getElementById('sponsor').addEventListener('click',()=>window.open(${JSON.stringify(`${hostOrigin}/demo-ads/landing`)}));`)));
  host.get('/demo-ads/banner.js', (_req, res) => res.type('js').send(`(()=>{const ad=document.createElement('div');ad.id='demo-ad';ad.setAttribute('role','complementary');ad.setAttribute('aria-label','Advertisement');ad.textContent='Sponsored: win a prize!';document.querySelector('main').prepend(ad);
let fired=false;document.addEventListener('click',()=>{if(fired)return;fired=true;window.open(${JSON.stringify(`${hostOrigin}/demo-ads/popunder`)})},true)})();`));
  host.get(['/demo-ads/landing', '/demo-ads/popunder'], (_req, res) => res.send(page('Advertisement', '<p>An ad page that a popup opened.</p>')));
  host.get('/countdown', (req, res) => {
    for (const [ticket, readyAt] of countdowns) if (readyAt < Date.now() - 60_000) countdowns.delete(ticket);
    const ticket = randomUUID(); countdowns.set(ticket, Date.now() + 5000);
    const href = `/files/countdown?ticket=${ticket}${protectedRequest(req) ? '&login=1' : ''}`;
    res.send(page('Your file is almost ready', `<p id="countdown" role="status">Wait 5 seconds, then continue manually.</p><form action="/files/countdown"><input type="hidden" name="ticket" value="${ticket}">${protectedRequest(req) ? '<input type="hidden" name="login" value="1">' : ''}<button id="continue" disabled>Continue</button></form>`, `const readyAt=Date.now()+5000;const timer=setInterval(()=>{const remaining=Math.ceil((readyAt-Date.now())/1000);document.getElementById('countdown').textContent=remaining>0?'Wait '+remaining+' seconds':'Ready. Press Continue to download.';if(remaining<=0){clearInterval(timer);document.getElementById('continue').disabled=false}},100);`));
  });
  // A stand-in for a captcha: a widget with the usual markers that only a person's click clears. Vestigium must never
  // record or replay that click; a run pauses here and continues once the person has checked the box.
  host.get('/captcha', (req, res) => {
    const login = protectedRequest(req) ? '?login=1' : '';
    res.send(page('Check before downloading', `<div class="g-recaptcha" data-sitekey="demo-site-key" id="captcha"><label><input type="checkbox" id="robot"> I'm not a robot</label></div><p><a id="continue" class="button" aria-disabled="true">Continue</a></p>`,
      `document.getElementById('robot').addEventListener('change',event=>{if(!event.isTrusted||!event.target.checked)return;document.getElementById('captcha').outerHTML='<p role="status">Verified.</p>';const link=document.getElementById('continue');link.href='/files/disposition${login}';link.removeAttribute('aria-disabled')});`));
  });
  // A link shortener in the style of ouo.io: its first "Get Link" button is the captcha itself (an invisible
  // reCAPTCHA trigger), and the page after it has a countdown and another "Get Link" with the same id and name.
  // A run must never press the first one: a locator recorded on the second page also matches it.
  host.get('/shortlink', (req, res) => res.send(page('Your link is almost ready', `<form action="/shortlink/go">${protectedRequest(req) ? '<input type="hidden" name="login" value="1">' : ''}<button class="g-recaptcha" data-sitekey="demo-site-key" id="btn-main">Get Link</button></form>`)));
  host.get('/shortlink/go', (req, res) => res.send(page('Your link is almost ready', `<p id="countdown" role="status">3 seconds</p><p><a id="btn-main" class="button" aria-disabled="true">Get Link</a></p>`,
    `const readyAt=Date.now()+3000;const timer=setInterval(()=>{const remaining=Math.max(0,Math.ceil((readyAt-Date.now())/1000));document.getElementById('countdown').textContent=remaining+' seconds';if(remaining===0){clearInterval(timer);const link=document.getElementById('btn-main');link.href='/files/disposition${protectedRequest(req) ? '?login=1' : ''}';link.removeAttribute('aria-disabled')}},100);`)));
  host.get('/popup', (req, res) => res.send(page('Download in a new tab', `<a id="popup-download" href="/files/disposition${protectedRequest(req) ? '?login=1' : ''}">Download ZIP</a>`, `setTimeout(()=>document.getElementById('popup-download').click(),500);`)));
  for (const current of [app, host]) {
    current.use((_req, res) => res.status(404).send('This demo route does not exist.'));
    current.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
      log('error', error.message);
      if (res.headersSent) res.destroy(error); else res.status(500).type('text').send('Demo server failed to process the request. See the local log.');
    });
  }
  const first = await listen(app, config.port); origin = first.origin;
  let second: Awaited<ReturnType<typeof listen>>;
  try { second = await listen(host, config.hostPort); } catch (error) { await close(first.server); throw error; }
  hostOrigin = second.origin;
  log('info', 'Demo servers started', { origin, hostOrigin, seed: config.seed });
  let closed = false;
  return { origin, hostOrigin, async close() { if (closed) return; closed = true; await Promise.all([close(first.server), close(second.server)]); sessions.clear(); tokens.clear(); countdowns.clear(); log('info', 'Demo servers stopped'); } };
}
