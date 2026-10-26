import { markOwn } from './dom.js';

// One overlay per frame, inside a closed shadow root so page CSS cannot restyle it and page scripts cannot reach in.
// pointer-events:none keeps it out of hit-testing, so it never becomes a click target or a recorded element.

interface Overlay {
  host: HTMLElement;
  box: HTMLElement;
  label: HTMLElement;
  badge: HTMLElement;
}

let overlay: Overlay | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let recording = false;

function ensure(document: Document): Overlay {
  if (overlay && overlay.host.isConnected) return overlay;
  const host = document.createElement('div');
  markOwn(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .box { position: fixed; display: none; border: 2px solid #3fb27f; background: rgba(63, 178, 127, .12); border-radius: 3px; }
    .box.flash { border-color: #e0a526; background: rgba(224, 165, 38, .18); }
    .label { position: fixed; display: none; font: 12px/1.4 system-ui, sans-serif; color: #fff; background: #1d4d3a;
      padding: 2px 6px; border-radius: 3px; max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { position: fixed; top: 8px; right: 8px; display: none; font: 600 12px/1 system-ui, sans-serif; color: #fff;
      background: #b3261e; padding: 6px 10px; border-radius: 12px; }
  </style><div class="box"></div><div class="label"></div><div class="badge">● Recording</div>`;
  overlay = {
    host,
    box: shadow.querySelector('.box')!,
    label: shadow.querySelector('.label')!,
    badge: shadow.querySelector('.badge')!,
  };
  (document.documentElement ?? document).appendChild(host);
  return overlay;
}

function place(target: Overlay, element: Element, text: string | null) {
  const rect = element.getBoundingClientRect();
  Object.assign(target.box.style, {
    display: 'block', left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  if (text) {
    target.label.textContent = text;
    Object.assign(target.label.style, { display: 'block', left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top - 22)}px` });
  } else {
    target.label.style.display = 'none';
  }
}

export function setRecording(document: Document, active: boolean, isTopFrame: boolean) {
  recording = active;
  if (active) {
    const target = ensure(document);
    target.badge.style.display = isTopFrame ? 'block' : 'none';
  } else if (overlay) {
    overlay.host.remove();
    overlay = null;
  }
}

// Hover outline while recording: shows what a click would capture.
export function outline(element: Element | null, text: string | null) {
  if (!recording || !overlay) return;
  if (!element) {
    overlay.box.style.display = 'none';
    overlay.label.style.display = 'none';
    return;
  }
  overlay.box.classList.remove('flash');
  place(overlay, element, text);
}

// Brief highlight of the element a replay step resolved to.
export function flash(element: Element) {
  const target = ensure(element.ownerDocument);
  target.box.classList.add('flash');
  place(target, element, null);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (!overlay) return;
    overlay.box.classList.remove('flash');
    overlay.box.style.display = 'none';
    if (!recording) {
      overlay.host.remove();
      overlay = null;
    }
  }, 700);
}

// Numbered boxes around every item of a list (item loops: "these are the items I found"). They live in their own
// closed shadow root, positioned in document coordinates so they scroll with the page, until replaced or cleared.
// Excluded items get a dashed red box. Returns how many boxes were drawn.
let itemLayer: HTMLElement | null = null;

export function markItems(document: Document, items: { element: Element; label: string; excluded: boolean }[]): number {
  itemLayer?.remove();
  itemLayer = null;
  const view = document.defaultView;
  if (!items.length || !view) return 0;
  const host = document.createElement('div');
  markOwn(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483646; }
    .item { position: absolute; box-sizing: border-box; border: 2px solid #3fb27f; background: rgba(63, 178, 127, .10); border-radius: 4px; }
    .item.excluded { border: 2px dashed #b3261e; background: rgba(179, 38, 30, .08); }
    .n { position: absolute; left: -2px; top: -2px; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: #1d4d3a;
      padding: 3px 6px; border-radius: 3px 0 3px 0; }
    .excluded .n { background: #b3261e; }
  </style>`;
  let drawn = 0;
  for (const { element, label, excluded } of items) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // hidden items are listed, but there is nothing to outline
    const box = document.createElement('div');
    box.className = excluded ? 'item excluded' : 'item';
    Object.assign(box.style, {
      left: `${rect.left + view.scrollX}px`, top: `${rect.top + view.scrollY}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const number = document.createElement('span');
    number.className = 'n';
    number.textContent = excluded ? `✕ ${label}` : label;
    box.append(number);
    shadow.append(box);
    drawn++;
  }
  (document.documentElement ?? document).appendChild(host);
  itemLayer = host;
  return drawn;
}
