import type { ElementCapture } from './recorder.js';
import type { Locator } from './types.js';

// Page analysis requests (main → recorder in a frame) and their results. Analysis reads the DOM only; it never
// clicks. Main turns reports into patterns with pure functions in src/main/learn/.

export interface ControlCandidate {
  capture: ElementCapture;
  disabled: boolean;
  // Why it was chosen, for the plain-language summary ("rel=next", "text \"Next →\"", ...).
  evidence: string[];
}

export interface PaginationReport {
  url: string;
  next: ControlCandidate | null;
  loadMore: ControlCandidate | null;
  // Numbered page links (1, 2, 3 …) with their absolute URLs, and the current page number when it is marked.
  numbered: { current: number | null; pages: { number: number; href: string }[] };
  contentLinks: number;
  scrollable: boolean;
}

// How a list moves to its next page. `url` uses the {{page}} placeholder.
export type PaginationPattern =
  | { kind: 'next'; locators: Locator[]; shadowHosts: string[]; description: string }
  | { kind: 'url'; template: string; description: string }
  | { kind: 'load-more'; locators: Locator[]; shadowHosts: string[]; description: string }
  | { kind: 'infinite-scroll'; description: string };

// What the list content currently is: a hash for repeat detection, and the absolute URLs of content links.
export interface PageSignature { hash: string; links: string[] }

export type ControlState = 'enabled' | 'disabled' | 'missing';

// How to find every item of a list again, by structure only. Tags, never classes or IDs: those are what changes
// between renders and deploys. Items are the children of `container` (whose parent has the tag `parent`) with tag
// `item`; each item is opened through the link at the child path `link` ("" when the item itself is the link).
export interface ItemPattern { parent: string; container: string; item: string; link: string; description: string }
export interface FoundItem { url: string; title: string }
// What the recorder saw on the list page when the user opened an item there.
export interface ListContext {
  url: string;
  items: { pattern: ItemPattern; count: number; index: number };
  pagination: PaginationReport;
}

// An item page's facts, read for the download's sidecar and filename template. `fields` follow the configured labels
// ("Password", "Author" …) and use the configured spelling as their label.
export interface PageMetadata { url: string; title: string; tags: string[]; date: string | null; fields: { label: string; value: string }[] }

// What on the page needs a person: a captcha (described), a login form, a countdown's text. Null/false when absent.
export interface Obstacles { captcha: string | null; login: boolean; countdown: string | null }

export type RecorderQuery =
  | { kind: 'analyze-pagination' }
  | { kind: 'signature' }
  | { kind: 'control-state'; locators: Locator[]; shadowHosts: string[] }
  // Scrolls to the bottom and reports how many content links exist before and after `waitMs`.
  | { kind: 'scroll-probe'; waitMs: number }
  // Lists the items of the page; `highlight` marks them on the page (excluded URLs differently) until cleared.
  | { kind: 'find-items'; pattern: ItemPattern; highlight: boolean; exclude: string[] }
  // Reads the page's title, tags, date and the values next to `labels`.
  | { kind: 'extract-metadata'; labels: string[] }
  | { kind: 'obstacles' };

export interface QueryResults {
  'analyze-pagination': PaginationReport;
  signature: PageSignature;
  'control-state': { state: ControlState };
  'scroll-probe': { before: number; after: number };
  // `loose`: nothing matched the exact link path, so each item's first link was used. `highlighted`: boxes drawn.
  'find-items': { items: FoundItem[]; loose: boolean; highlighted: number };
  'extract-metadata': PageMetadata;
  obstacles: Obstacles;
}
