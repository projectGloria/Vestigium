import { normalizeText } from './dom.js';

// A deliberately small subset of WAI-ARIA role mapping and accessible-name computation.
// It only has to be *consistent* between recording and replay in the same engine, not spec-complete.

const INPUT_ROLES: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', password: 'textbox',
};

const TAG_ROLES: Record<string, string> = {
  button: 'button', summary: 'button', textarea: 'textbox', option: 'option', nav: 'navigation', main: 'main',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
  article: 'article', dialog: 'dialog', header: 'banner', footer: 'contentinfo', aside: 'complementary',
  progress: 'progressbar', fieldset: 'group',
};

// Roles whose accessible name comes from their text content when no label exists.
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'option', 'cell', 'columnheader', 'rowheader', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'treeitem', 'listitem', 'tooltip',
]);

export function roleOf(element: Element): string | null {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const tag = element.localName.toLowerCase();
  if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : null;
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden') return null;
    // Text-like types not listed (date, time, ...) still behave as text entry for our purposes.
    return INPUT_ROLES[type] ?? 'textbox';
  }
  if (tag === 'select') {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
  }
  if (tag === 'img') return element.getAttribute('alt') === '' ? null : 'img';
  // Forms and sections are only landmarks when named; otherwise they are plain containers.
  if ((tag === 'form' || tag === 'section') && labelAttributes(element)) return tag === 'form' ? 'form' : 'region';
  return TAG_ROLES[tag] ?? null;
}

function labelAttributes(element: Element): string {
  return normalizeText(element.getAttribute('aria-label') ?? '') || labelledBy(element);
}

function labelledBy(element: Element): string {
  const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? [];
  if (ids.length === 0) return '';
  // IDs resolve within the element's own tree (document or shadow root), as the spec requires.
  const root = element.getRootNode() as Document | ShadowRoot;
  return normalizeText(ids.map(id => root.getElementById?.(id)?.textContent ?? '').join(' '));
}

export function contentText(element: Element): string {
  // Visible text plus alt text of images, so icon links with alt text get a name.
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    else if (node instanceof Element) {
      const tag = node.localName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'template' || node.getAttribute('aria-hidden') === 'true') return;
      if (tag === 'img') text += ` ${node.getAttribute('alt') ?? ''} `;
      for (const child of node.childNodes) walk(child);
      // Block-level children read as separate words.
      text += ' ';
    }
  };
  walk(element);
  return normalizeText(text);
}

export function nameOf(element: Element): string {
  const fromAttributes = labelledBy(element) || normalizeText(element.getAttribute('aria-label') ?? '');
  if (fromAttributes) return cap(fromAttributes);
  const tag = element.localName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const field = element as HTMLInputElement;
    const type = (field.getAttribute('type') ?? '').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) return cap(field.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
    if (type === 'image') return cap(field.getAttribute('alt') ?? '');
    // Label text excluding the field's own content (a <label> wrapping a <select> would otherwise include every option).
    const labels = [...(field.labels ?? [])].map(label => labelText(label, element)).join(' ');
    if (normalizeText(labels)) return cap(normalizeText(labels));
    return cap(normalizeText(field.getAttribute('placeholder') ?? field.getAttribute('title') ?? ''));
  }
  if (tag === 'img' || tag === 'area') return cap(normalizeText(element.getAttribute('alt') ?? element.getAttribute('title') ?? ''));
  const role = roleOf(element);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = contentText(element);
    if (text) return cap(text);
  }
  return cap(normalizeText(element.getAttribute('title') ?? ''));
}

function labelText(label: HTMLLabelElement, control: Element): string {
  let text = '';
  const walk = (node: Node) => {
    if (node === control) return;
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    else for (const child of node.childNodes) walk(child);
    if (node instanceof Element) text += ' ';
  };
  walk(label);
  return normalizeText(text);
}

const cap = (text: string) => (text.length > 200 ? text.slice(0, 200) : text);
