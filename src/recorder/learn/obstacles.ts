import type { Obstacles } from '../../shared/learn.js';

// Things on a page that only a person can get past (plan §4, human-in-the-loop): a captcha, a login form, a countdown.
// Vestigium never solves or clicks these; the runner pauses, shows the page, and continues once they are gone.
// Generic markers only: the widget classes and frames of the common captcha providers, a visible password form, and
// visible "N seconds" text.

const CAPTCHA_SELECTOR = [
  '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]', '#captcha', '[id*="captcha" i]', '[class*="captcha" i]',
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]', 'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]', 'iframe[title*="captcha" i]', 'iframe[title*="challenge" i]',
].join(', ');

// Captcha providers' own frames: the recorder never records inside them, so a run can never replay a captcha click.
export const isCaptchaFrame = (location: Location) =>
  /(^|\.)(google\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com)$/.test(location.hostname)
  && /captcha|challenge|turnstile|arkose|anchor|bframe/i.test(location.pathname + location.search);

const visible = (element: Element) => element.getClientRects().length > 0;

export const isCaptchaElement = (element: Element) => element.closest(CAPTCHA_SELECTOR) !== null;

function captcha(document: Document): string | null {
  const widget = [...document.querySelectorAll(CAPTCHA_SELECTOR)].find(visible);
  if (widget) return widget.localName === 'iframe' ? 'a captcha' : `a captcha (${(widget.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'verification'})`;
  const text = (document.body?.innerText ?? '').slice(0, 20_000);
  return /\b(i'?m not a robot|verify (that )?you are (a )?human|are you a robot)\b/i.test(text) ? 'a human verification' : null;
}

// A visible password field inside a form (or next to a submit button): the site wants someone to sign in.
function login(document: Document): boolean {
  return [...document.querySelectorAll('input[type="password"]')].some(field => visible(field)
    && (field.closest('form') !== null || document.querySelector('button[type="submit"], input[type="submit"]') !== null));
}

// "Wait 5 seconds", "3 s", "Please wait…": the text of a countdown, if one is showing.
function countdown(document: Document): string | null {
  for (const element of document.querySelectorAll('[role="status"], [aria-live], p, span, div, strong, b')) {
    if (element.children.length > 2 || !visible(element)) continue;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length <= 120
      && /\b\d+\s*(s|sec|secs|seconds?|saniye|segundos?|secondes?|sekunden|секунд\w*)\b|please wait|bitte warten|lütfen bekleyin/i.test(text)) return text;
  }
  return null;
}

export function findObstacles(document: Document): Obstacles {
  return { captcha: captcha(document), login: login(document), countdown: countdown(document) };
}
