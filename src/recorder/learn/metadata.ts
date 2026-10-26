import type { PageMetadata } from '../../shared/learn.js';
import { CHROME } from './content.js';

// Reads an item page's facts (plan §2, "metadata capture"): the title, tags, date, and the text next to the labels the
// user configured ("Password", "Unzip password", "Model", "Author" …). Structure only, no site-specific selectors:
//   <dt>Label</dt><dd>value</dd> · table rows (th/td, or two cells) · "Label: value" in one short element ·
//   a label element followed by its value (<strong>Pass</strong> <span>value</span>).
// Labels match case-insensitively, ignoring a trailing colon. The first match in document order wins.

const MAX_VALUE = 1000;

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
// "Unzip password:" → "unzip password". Locale-free lowercasing keeps "Şifre" → "şifre".
export const labelKey = (text: string) => clean(text).replace(/[\s:：\-–—]+$/u, '').toLowerCase();

function visible(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function valueOf(element: Element): string {
  if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement || element instanceof element.ownerDocument.defaultView!.HTMLTextAreaElement) {
    // A password shown in a read-only field is still a password shown to the user; a type=password field is not.
    return element.type === 'password' ? '' : element.value;
  }
  return (element as HTMLElement).innerText ?? element.textContent ?? '';
}

export function extractMetadata(document: Document, labels: string[]): PageMetadata {
  const wanted = new Map(labels.map(label => [labelKey(label), label]));
  const fields = new Map<string, string>();
  const offer = (label: string, value: string) => {
    const configured = wanted.get(labelKey(label));
    const text = clean(value).slice(0, MAX_VALUE);
    if (configured && text && !fields.has(configured)) fields.set(configured, text);
  };

  // 1. Definition lists: every dd until the next dt belongs to the dt before it.
  for (const term of document.querySelectorAll('dt')) {
    if (!visible(term)) continue;
    const values: string[] = [];
    for (let next = term.nextElementSibling; next && next.localName !== 'dt'; next = next.nextElementSibling) {
      if (next.localName === 'dd') values.push(valueOf(next));
    }
    if (values.length) offer(valueOf(term), values.join(', '));
  }
  // 2. Table rows: a short first cell is the label, the second the value.
  for (const row of document.querySelectorAll('tr')) {
    const cells = [...row.children].filter(cell => cell.localName === 'th' || cell.localName === 'td');
    if (cells.length >= 2 && visible(row) && clean(valueOf(cells[0])).length <= 40) offer(valueOf(cells[0]), valueOf(cells[1]));
  }
  // 3. "Label: value" inside one short element, and 4. a label element followed by its value.
  for (const element of document.querySelectorAll('p, li, div, span, td, small, strong, b, label, em')) {
    if (element.children.length > 4 || !visible(element)) continue;
    const raw = valueOf(element).trim();
    const text = clean(raw);
    // One rendered line only: innerText puts line breaks between block children, and a wrapper around several
    // "Label: value" lines would otherwise read as one label followed by everything else.
    if (text.length > 0 && text.length <= 300 && !raw.includes('\n')) {
      const inline = /^([^:：]{1,40})[:：]\s*(.+)$/u.exec(text);
      if (inline) offer(inline[1], inline[2]);
    }
    const sibling = element.nextElementSibling;
    if (sibling && text.length <= 40 && wanted.has(labelKey(text)) && visible(sibling)) offer(text, valueOf(sibling));
  }

  // The item's own heading, outside site chrome; the document title as a fallback.
  const heading = [...document.querySelectorAll('h1')].find(element => visible(element) && !element.closest(CHROME));
  const title = clean(heading ? valueOf(heading) : document.title).slice(0, 300);
  const tags = [...new Set([...document.querySelectorAll('a[rel~="tag"]')].filter(visible).map(link => clean(valueOf(link))).filter(Boolean))];
  const time = [...document.querySelectorAll('time[datetime]')].find(visible);
  return {
    url: document.location.href, title, tags, date: time?.getAttribute('datetime') ?? null,
    fields: [...fields].map(([label, value]) => ({ label, value })),
  };
}
