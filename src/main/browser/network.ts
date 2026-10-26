import type { OnBeforeRequestListenerDetails, Session } from 'electron';
import type { AdBlocker, Decision } from './ad-blocker.js';

// Tracks in-flight requests per tab so the runner can wait for "network idle" before acting, the way a person
// waits for a page to finish loading. Long-lived requests (streams, long polling, downloads, WebSockets) would
// keep a page "busy" forever, so anything older than LONG_MS no longer counts.
// The same listener asks the ad blocker first: Electron keeps one onBeforeRequest listener per session, so blocking
// cannot live in a listener of its own. Blocked requests are not counted (they never load, so they never finish).

const LONG_MS = 10_000;
const POLL_MS = 100;

interface Request { contentsId: number; startedAt: number }

export class NetworkMonitor {
  private requests = new Map<number, Request>();
  private lastActivity = new Map<number, number>();

  constructor(private session: Session, blocker?: AdBlocker) {
    const filter = { urls: ['*://*/*'] };
    session.webRequest.onBeforeRequest(filter, (details, callback) => {
      let decision: Decision = null;
      try {
        decision = blocker?.decide({ url: details.url, resourceType: details.resourceType, webContentsId: details.webContentsId,
          referrer: details.referrer, topUrl: topUrl(details) }) ?? null;
        if (!decision && details.webContentsId !== undefined && details.resourceType !== 'webSocket') {
          this.requests.set(details.id, { contentsId: details.webContentsId, startedAt: Date.now() });
          this.lastActivity.set(details.webContentsId, Date.now());
        }
      } finally {
        // Every request gets an answer, even if matching threw: an unanswered request would hang the page.
        callback(decision ?? {});
      }
    });
    session.webRequest.onCompleted(filter, details => this.finish(details.id));
    session.webRequest.onErrorOccurred(filter, details => this.finish(details.id));
  }

  private finish(id: number) {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    this.lastActivity.set(request.contentsId, Date.now());
  }

  busy(contentsId: number, now = Date.now()): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.contentsId === contentsId && now - request.startedAt < LONG_MS) count++;
    }
    return count;
  }

  // Resolves true once the tab had no counted request for `quietMs`, or false when `limitMs` runs out first.
  async idle(contentsId: number, quietMs: number, limitMs: number, signal?: AbortSignal): Promise<boolean> {
    const end = Date.now() + limitMs;
    while (Date.now() < end && !signal?.aborted) {
      const now = Date.now();
      if (this.busy(contentsId, now) === 0 && now - (this.lastActivity.get(contentsId) ?? 0) >= quietMs) return true;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return false;
  }

  dispose() {
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onCompleted(null);
    this.session.webRequest.onErrorOccurred(null);
    this.requests.clear();
  }
}

// The page the request belongs to, for first/third-party and $domain= filters. The frame can already be gone
// (a closed tab, a replaced iframe), and reading a disposed frame throws; the referrer is the fallback.
function topUrl(details: OnBeforeRequestListenerDetails): string | null {
  try { return details.frame?.top?.url || null; } catch { return null; }
}
