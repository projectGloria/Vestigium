import type { FrameRef, Locator } from './types.js';
import type { ListContext } from './learn.js';

// What the recorder knows about an element at capture time.
// `description` feeds plain-language step labels; it never drives replay (locators do).
export interface ElementCapture {
  locators: Locator[];
  shadowHosts: string[];
  description: { tag: string; role: string | null; name: string | null };
}

// Events produced inside a page by the injected recorder. The page never sees these objects:
// they travel from the isolated-world preload to main, where they are validated before use.
export type PageEvent =
  // `list`: the click opened a link that is one of many similar items (top frame only), with what the list page offered.
  | { kind: 'click'; target: ElementCapture; list?: ListContext }
  | { kind: 'input'; target: ElementCapture; value: string }
  | { kind: 'select'; target: ElementCapture; value: string; label: string }
  | { kind: 'key'; target: ElementCapture; key: 'Enter' | 'Tab' }
  | { kind: 'scroll'; target: ElementCapture | null; x: number; y: number }
  // A password/payment field was used. Carries nothing about the field, only that something was skipped.
  | { kind: 'sensitive' }
  // The user clicked a captcha widget. Never recorded: a run pauses there for a person instead of clicking it.
  | { kind: 'captcha' };

// Main stamps where and when each page event happened; senderFrame is trusted, page-supplied context is not.
export type LocatedPageEvent = PageEvent & { at: number; tab: string; frames: FrameRef[] };

// Events main observes directly from WebContents/session, which a page script cannot see or fake.
export type BrowserEvent =
  // fromAddressBar: the user navigated with the shell (URL box, Back/Forward/Reload), not through the page.
  | { kind: 'navigate'; at: number; tab: string; url: string; inPage: boolean; fromAddressBar: boolean }
  // `tab` is the opener; `popup` is the alias assigned to the newly opened tab.
  | { kind: 'popup'; at: number; tab: string; popup: string }
  | { kind: 'download'; at: number; tab: string; url: string; filename: string | null; mimeType: string | null };

export type RecordedEvent = LocatedPageEvent | BrowserEvent;

// Channels between the recorder preload (isolated world, every frame) and main. Not part of the shell bridge.
export const RECORDER_CHANNELS = {
  ready: 'vestigium:recorder:ready',
  arm: 'vestigium:recorder:arm',
  event: 'vestigium:recorder:event',
  command: 'vestigium:recorder:command',
  // Read-only page analysis (see shared/learn.ts); answered on the same result channel.
  query: 'vestigium:recorder:query',
  result: 'vestigium:recorder:result',
} as const;

// Replay actions performed in-page once the target is resolved. 'none' only resolves (used by tests and dry runs).
// 'locate' prepares a trusted click: it scrolls the target into view, makes sure nothing covers it, and returns the
// point main should click with OS-level input.
export type RecorderAction =
  | { kind: 'none' }
  | { kind: 'locate' }
  | { kind: 'click' }
  | { kind: 'type'; value: string | null; key?: 'Enter' | 'Tab' }
  | { kind: 'select'; value: string; label: string }
  | { kind: 'scroll'; x: number; y: number };

// Empty locators with a scroll action address the window.
export interface RecorderCommand {
  locators: Locator[];
  shadowHosts: string[];
  action: RecorderAction;
  highlight: boolean;
  // Allow a fuzzy match (role/name/structure) when no recorded locator matches. Off for verification-only calls.
  heal: boolean;
}

// 'not-ready' (found but hidden/disabled) and 'not-found' are retryable by main until the step times out.
// On 'done': `point` (locate only) is in the frame's viewport, CSS pixels. `refreshed` holds locators rebuilt from the
// element actually used, present whenever the best recorded locator did not match (fallback or heal), so main can
// update the workflow. `healed` explains a fuzzy match. `banner` names a consent button that was dismissed first.
export type RecorderResult =
  | {
    status: 'done'; strategy: Locator['strategy'] | 'window' | 'healed'; value: string;
    point?: { x: number; y: number }; refreshed?: Locator[]; healed?: string; banner?: string;
  }
  | { status: 'not-found'; message: string }
  | { status: 'not-ready'; message: string }
  | { status: 'error'; message: string };
