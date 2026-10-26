import { nameOf } from './aria.js';
import { type Root, isOwn, isVisible } from './dom.js';

// What a user would hit when clicking the middle of `element`, if that is something else (an overlay, a banner).
export function coveredBy(element: Element): Element | null {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const view = element.ownerDocument.defaultView;
  if (!view || x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return null;
  // Hit-test in the element's own tree (document or shadow root), so the answer is comparable with `element`.
  const root = element.getRootNode() as Root;
  const hit = root.elementFromPoint(x, y);
  if (!hit || hit === element || element.contains(hit) || isOwn(hit)) return null;
  // A <label> for the target forwards the click to it; that is not an obstruction.
  if (hit instanceof HTMLLabelElement && hit.control === element) return null;
  return hit;
}

const CONTAINER = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[id*="cookie" i]', '[class*="cookie" i]',
  '[id*="consent" i]', '[class*="consent" i]', '[id*="gdpr" i]', '[class*="gdpr" i]', '[id*="cmp" i]',
].join(', ');
const CONSENT = /cookie|consent|gdpr|privacy|çerez|datenschutz|confidentialité|privacidad/i;
// Most privacy-preserving choice first: reject, then necessary-only, then accept, then a plain close button.
const CHOICES = [
  /^(reject|decline|deny|refuse|reddet|ablehnen|alle ablehnen|refuser|tout refuser|rechazar)( all)?\b/i,
  /\b(only (necessary|essential|required))\b|\b(necessary|essential|required) (cookies )?only\b|^use necessary/i,
  /^(accept|agree|allow|ok|okay|got it|i understand|understood|kabul|akzeptieren|alle akzeptieren|accepter|tout accepter|aceptar|zustimmen|tamam)\b/i,
  /^(close|dismiss|×|x|✕)$/i,
];

export const describeNode = (element: Element) =>
  `<${element.localName}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className.trim() ? `.${element.className.trim().split(/\s+/)[0]}` : ''}>`;

// If `cover` belongs to a cookie/consent banner, presses its best dismiss button and returns that button's name.
// Anything that is not recognizably a consent banner is left alone: other overlays are the user's business.
export function dismissConsentBanner(cover: Element): string | null {
  const container = cover.closest(CONTAINER);
  if (!container) return null;
  const evidence = `${container.id} ${typeof container.className === 'string' ? container.className : ''} ${container.getAttribute('aria-label') ?? ''} ${container.textContent ?? ''}`;
  if (!CONSENT.test(evidence)) return null;
  const buttons = [...container.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href]')]
    .filter(button => isVisible(button));
  for (const choice of CHOICES) {
    const button = buttons.find(candidate => choice.test(nameOf(candidate)));
    if (button instanceof HTMLElement) {
      button.click();
      return nameOf(button);
    }
  }
  return null;
}
